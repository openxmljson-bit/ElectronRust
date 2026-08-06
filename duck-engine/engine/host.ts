/**
 * Engine host.
 *
 * Runs as a separate OS process (Electron's utilityProcess in the app, a plain
 * forked Node process in tests). Everything expensive happens here, so a 20 GB
 * ingest cannot stall the window, and a hard engine failure costs a restart
 * rather than the whole application.
 */

import { totalmem } from 'node:os';
import { basename } from 'node:path';
import type {
  DatasetManifest,
  EngineEvent,
  EngineStats,
  JobKind,
  JobProgress,
  PageRequest,
  RpcRequest,
  RpcResponse,
  ViewSpec,
} from '../shared/protocol.js';
import { PROTOCOL_VERSION } from '../shared/protocol.js';
import { DatasetCache, dirSize } from './cache.js';
import { EngineDb, EngineError, mapDuckError } from './db.js';
import { detectFile } from './detect.js';
import { Ingestor, previewRows } from './ingest.js';
import { Profiler } from './profile.js';
import { rawSlice } from './raw.js';
import { Differ, Exporter, SqlConsole } from './tools.js';
import { PARQUET_ROWNUM, quotePath } from './sql.js';
import { ViewManager } from './view.js';

/* --------------------------------------------------------------- transport */

interface Transport {
  send(message: unknown): void;
  onMessage(handler: (message: unknown) => void): void;
}

function makeTransport(): Transport {
  const parentPort = (process as unknown as { parentPort?: NodeJS.EventEmitter & { postMessage(v: unknown): void } })
    .parentPort;
  if (parentPort) {
    return {
      send: (m) => parentPort.postMessage(m),
      onMessage: (h) =>
        parentPort.on('message', (e: { data?: unknown }) => h(e && 'data' in e ? e.data : e)),
    };
  }
  if (typeof process.send === 'function') {
    return {
      send: (m) => process.send!(m),
      onMessage: (h) => process.on('message', (m) => h(m)),
    };
  }
  throw new Error('No IPC channel available for the engine host.');
}

const transport = makeTransport();

function emit(event: EngineEvent): void {
  transport.send({ event });
}

function log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
  emit({ type: 'log', level, message, at: Date.now() });
}

/* ------------------------------------------------------------------- state */

interface HostConfig {
  cacheRoot: string;
  cacheLimitBytes: number;
  memoryLimitMb: number | null;
  threads: number | null;
  maxTempBytes: number;
}

const startedAt = Date.now();

let db: EngineDb | null = null;
let cache: DatasetCache | null = null;
let ingestor: Ingestor | null = null;
let views: ViewManager | null = null;
let profiler: Profiler | null = null;
let sqlConsole: SqlConsole | null = null;
let exporter: Exporter | null = null;
let differ: Differ | null = null;

const datasets = new Map<string, DatasetManifest>();

function requireReady(): {
  db: EngineDb;
  cache: DatasetCache;
  views: ViewManager;
} {
  if (!db || !cache || !views) throw new EngineError('engine-down', 'The engine is still starting.');
  return { db, cache, views };
}

function dataset(id: string): DatasetManifest {
  const m = datasets.get(id);
  if (!m) throw new EngineError('not-found', 'That dataset is no longer open.');
  return m;
}

/* -------------------------------------------------------------------- jobs */

const jobStarts = new Map<string, number>();
const lastEmit = new Map<string, number>();

interface Reporter {
  (patch: Partial<JobProgress> & { phase?: string }): void;
}

function makeReporter(jobId: string, kind: JobKind, label: string): Reporter {
  jobStarts.set(jobId, Date.now());
  let last: JobProgress = {
    jobId,
    kind,
    label,
    phase: 'Starting',
    percent: null,
    indeterminate: true,
    bytesDone: null,
    bytesTotal: null,
    rowsDone: null,
    elapsedMs: 0,
    etaMs: null,
    cancellable: true,
  };
  emit({ type: 'job', progress: last });
  lastEmit.set(jobId, Date.now());

  return (patch) => {
    const now = Date.now();
    const elapsedMs = now - (jobStarts.get(jobId) ?? now);
    const percent = patch.percent === undefined ? last.percent : patch.percent;
    const etaMs =
      percent !== null && percent > 1 && percent < 100
        ? Math.max(0, Math.round((elapsedMs / percent) * (100 - percent)))
        : null;
    const next: JobProgress = {
      ...last,
      ...patch,
      percent,
      indeterminate: percent === null,
      elapsedMs,
      etaMs,
    };
    last = next;
    // The renderer redraws on every event; a few per second is plenty.
    const since = now - (lastEmit.get(jobId) ?? 0);
    const isFinal = percent !== null && percent >= 100;
    if (since >= 120 || isFinal || patch.phase !== undefined) {
      lastEmit.set(jobId, now);
      emit({ type: 'job', progress: next });
    }
  };
}

async function withJob<T>(
  jobId: string,
  kind: JobKind,
  label: string,
  fn: (report: Reporter) => Promise<T>,
): Promise<T> {
  const report = makeReporter(jobId, kind, label);
  try {
    const result = await fn(report);
    emit({ type: 'job-end', jobId, ok: true });
    return result;
  } catch (err) {
    const e = err instanceof EngineError ? err : mapDuckError(err);
    emit({
      type: 'job-end',
      jobId,
      ok: false,
      error: e.message,
      cancelled: e.code === 'cancelled',
    });
    throw e;
  } finally {
    jobStarts.delete(jobId);
    lastEmit.delete(jobId);
  }
}

/* ----------------------------------------------------------------- helpers */

async function resolveView(
  datasetId: string,
  view: ViewSpec,
  jobId: string,
  report?: Reporter,
) {
  const { views: vm } = requireReady();
  const manifest = dataset(datasetId);
  return await vm.resolve(manifest, view, `${jobId}-view`, (p) => {
    report?.({
      phase: p.phase,
      percent: p.percent,
      rowsDone: p.rowsDone,
    });
  });
}

/* ----------------------------------------------------------------- methods */

type Handler = (params: any) => Promise<unknown> | unknown;

const handlers: Record<string, Handler> = {
  async init(params: HostConfig) {
    if (db) return { ok: true, already: true };
    emit({ type: 'engine-state', state: 'starting' });
    cache = new DatasetCache(params.cacheRoot, params.cacheLimitBytes);
    await cache.init();
    db = new EngineDb();
    await db.init({
      tempDir: cache.paths.tmp,
      memoryLimitMb: params.memoryLimitMb,
      threads: params.threads,
      maxTempBytes: params.maxTempBytes,
      preserveInsertionOrder: true,
    });
    ingestor = new Ingestor(db, cache);
    views = new ViewManager(db, cache);
    profiler = new Profiler(db);
    sqlConsole = new SqlConsole(db);
    exporter = new Exporter(db);
    differ = new Differ(db);

    const pruned = await cache.prune();
    if (pruned.removed > 0) {
      log('info', `Pruned ${pruned.removed} cached dataset(s) to stay within the cache limit.`);
    }
    emit({ type: 'engine-state', state: 'ready' });
    return { ok: true };
  },

  ping() {
    return { ok: true, version: PROTOCOL_VERSION };
  },

  async stats(): Promise<EngineStats> {
    const { db: d, cache: c } = requireReady();
    const version = (await d.queryScalar('SELECT version()').catch(() => null)) ?? 'unknown';
    const cacheBytes = await dirSize(c.paths.datasets);
    return {
      duckdbVersion: version,
      threads: d.threads,
      memoryLimit: d.memoryLimit,
      tempDir: d.tempDir,
      totalSystemMemory: totalmem(),
      engineRss: process.memoryUsage.rss(),
      openDatasets: datasets.size,
      cacheBytes,
      uptimeMs: Date.now() - startedAt,
      restarts: 0,
    };
  },

  async detect(params: { path: string }) {
    const { cache: c } = requireReady();
    const result = await detectFile(params.path);
    const reusable = await c.findReusable(params.path, result.sizeBytes, result.mtimeMs, {
      format: result.format,
      delimiter: result.delimiter,
      quote: result.quote,
      escape: result.escape,
      hasHeader: result.hasHeader,
      encoding: result.encoding,
      nullPadding: true,
      sampleSize: 200_000,
    });
    return { ...result, cached: reusable !== null };
  },

  async previewRows(params: { path: string; options: any; limit: number }) {
    const { db: d } = requireReady();
    return await previewRows(d, params.path, params.options ?? {}, params.limit ?? 30);
  },

  async openDataset(params: { path: string; options: any; jobId: string }) {
    const { cache: c } = requireReady();
    if (!ingestor) throw new EngineError('engine-down', 'Engine not ready.');
    const manifest = await withJob(
      params.jobId,
      'ingest',
      `Opening ${basename(params.path)}`,
      async (report) =>
        await ingestor!.open({
          path: params.path,
          options: params.options ?? {},
          jobId: params.jobId,
          onProgress: (p) =>
            report({
              phase: p.phase,
              percent: p.percent,
              rowsDone: p.rowsDone,
              bytesDone: p.bytesDone,
              bytesTotal: p.bytesTotal,
            }),
        }),
    );
    datasets.set(manifest.id, manifest);
    void c.prune([...datasets.keys()]).catch(() => {});
    return manifest;
  },

  closeDataset(params: { datasetId: string }) {
    const { views: vm } = requireReady();
    datasets.delete(params.datasetId);
    vm.forgetDataset(params.datasetId);
    return { ok: true };
  },

  listDatasets() {
    return [...datasets.values()];
  },

  async buildView(params: { datasetId: string; view: ViewSpec; jobId: string }) {
    const { views: vm } = requireReady();
    const manifest = dataset(params.datasetId);
    const resolved = await withJob(
      params.jobId,
      'materialize',
      'Preparing the view',
      async (report) =>
        await vm.resolve(manifest, params.view, `${params.jobId}-view`, (p) =>
          report({ phase: p.phase, percent: p.percent, rowsDone: p.rowsDone }),
        ),
    );
    return vm.info(resolved);
  },

  async getPage(params: PageRequest) {
    const { views: vm } = requireReady();
    const manifest = dataset(params.datasetId);
    // Paging may need to build the view first; that is reported as its own job
    // so the UI can show progress instead of appearing to hang.
    const jobId = `page-${manifest.id}`;
    const resolved = await vm.resolve(manifest, params.view, `${jobId}-view`, (p) => {
      emit({
        type: 'job',
        progress: {
          jobId,
          kind: 'materialize',
          label: 'Preparing the view',
          phase: p.phase,
          percent: p.percent,
          indeterminate: p.percent === null,
          bytesDone: null,
          bytesTotal: null,
          rowsDone: p.rowsDone,
          elapsedMs: 0,
          etaMs: null,
          cancellable: true,
        },
      });
    });
    const page = await vm.page(manifest, params, resolved);
    emit({ type: 'job-end', jobId, ok: true });
    return page;
  },

  async getRowJson(params: { datasetId: string; view: ViewSpec; viewRow: number }) {
    const { views: vm } = requireReady();
    const resolved = await resolveView(params.datasetId, params.view, 'rowjson');
    return await vm.rowJson(resolved, params.viewRow);
  },

  async findNextMatch(params: {
    datasetId: string;
    view: ViewSpec;
    fromViewRow: number;
    direction: 'next' | 'prev';
  }) {
    const { views: vm } = requireReady();
    const resolved = await resolveView(params.datasetId, params.view, 'findmatch');
    const viewRow = await vm.findMatch(
      resolved,
      params.view.search,
      params.fromViewRow,
      params.direction,
    );
    return { viewRow };
  },

  async countMatches(params: { datasetId: string; view: ViewSpec }) {
    const { views: vm } = requireReady();
    const resolved = await resolveView(params.datasetId, params.view, 'countmatches');
    return { count: await vm.countMatches(resolved, params.view.search) };
  },

  async profileColumn(params: {
    datasetId: string;
    view: ViewSpec;
    column: string;
    topN: number;
    jobId: string;
  }) {
    const { views: vm } = requireReady();
    if (!profiler) throw new EngineError('engine-down', 'Engine not ready.');
    return await withJob(params.jobId, 'profile', `Profiling ${params.column}`, async (report) => {
      const resolved = await resolveView(params.datasetId, params.view, params.jobId, report);
      report({ phase: 'Scanning column' });
      return await profiler!.column(
        vm.relation(resolved),
        resolved,
        params.column,
        params.topN ?? 20,
      );
    });
  },

  async profileAll(params: { datasetId: string; view: ViewSpec; jobId: string }) {
    const { views: vm } = requireReady();
    if (!profiler) throw new EngineError('engine-down', 'Engine not ready.');
    return await withJob(params.jobId, 'profile', 'Profiling every column', async (report) => {
      const resolved = await resolveView(params.datasetId, params.view, params.jobId, report);
      report({ phase: 'Scanning columns' });
      return await profiler!.all(vm.relation(resolved), resolved);
    });
  },

  async distinctValues(params: {
    datasetId: string;
    view: ViewSpec;
    column: string;
    limit: number;
    contains: string | null;
  }) {
    const { views: vm } = requireReady();
    if (!profiler) throw new EngineError('engine-down', 'Engine not ready.');
    const resolved = await resolveView(params.datasetId, params.view, 'distinct');
    const col = resolved.columns.find((c) => c.name === params.column);
    if (!col) throw new EngineError('invalid-request', `No column named ${params.column}.`);
    return {
      values: await profiler.distinctValues(
        vm.relation(resolved),
        col,
        params.limit ?? 200,
        params.contains ?? null,
      ),
    };
  },

  async runSql(params: { datasetId: string | null; sql: string; limit: number; jobId: string }) {
    if (!sqlConsole) throw new EngineError('engine-down', 'Engine not ready.');
    return await withJob(params.jobId, 'sql', 'Running your query', async () => {
      let resolved = null;
      let manifest: DatasetManifest | null = null;
      if (params.datasetId) {
        manifest = dataset(params.datasetId);
        resolved = await resolveView(params.datasetId, {
          filters: [],
          combine: 'and',
          search: null,
          sort: [],
          select: null,
        }, params.jobId);
      }
      return await sqlConsole!.run({
        sql: params.sql,
        jobId: `${params.jobId}-exec`,
        limit: params.limit ?? 5000,
        view: resolved,
        manifest,
      });
    });
  },

  async runSqlOnView(params: {
    datasetId: string;
    view: ViewSpec;
    sql: string;
    limit: number;
    jobId: string;
  }) {
    if (!sqlConsole) throw new EngineError('engine-down', 'Engine not ready.');
    return await withJob(params.jobId, 'sql', 'Running your query', async (report) => {
      const manifest = dataset(params.datasetId);
      const resolved = await resolveView(params.datasetId, params.view, params.jobId, report);
      return await sqlConsole!.run({
        sql: params.sql,
        jobId: `${params.jobId}-exec`,
        limit: params.limit ?? 5000,
        view: resolved,
        manifest,
      });
    });
  },

  async exportView(params: any) {
    const { views: vm } = requireReady();
    if (!exporter) throw new EngineError('engine-down', 'Engine not ready.');
    return await withJob(params.jobId, 'export', `Exporting to ${basename(params.targetPath)}`, async (report) => {
      const resolved = await resolveView(params.datasetId, params.view, params.jobId, report);
      report({ phase: 'Writing rows' });
      return await exporter!.run({
        req: params,
        view: resolved,
        relation: vm.relation(resolved),
        jobId: `${params.jobId}-copy`,
        onProgress: (percent, rows) => report({ percent, rowsDone: rows, phase: 'Writing rows' }),
      });
    });
  },

  async diffDatasets(params: any) {
    const { views: vm } = requireReady();
    if (!differ) throw new EngineError('engine-down', 'Engine not ready.');
    return await withJob(params.jobId, 'diff', 'Comparing datasets', async (report) => {
      const emptyView: ViewSpec = {
        filters: [],
        combine: 'and',
        search: null,
        sort: [],
        select: null,
      };
      const left = await resolveView(params.leftId, params.leftView ?? emptyView, `${params.jobId}-l`, report);
      const right = await resolveView(params.rightId, params.rightView ?? emptyView, `${params.jobId}-r`, report);
      report({ phase: 'Joining rows' });
      return await differ!.run({
        req: params,
        left: { relation: vm.relation(left), view: left },
        right: { relation: vm.relation(right), view: right },
        jobId: `${params.jobId}-join`,
        onProgress: (percent) => report({ percent, phase: 'Joining rows' }),
      });
    });
  },

  async rawSlice(params: { path: string; offset: number; length: number }) {
    return await rawSlice(params.path, params.offset, params.length);
  },

  async cacheInfo() {
    const { cache: c } = requireReady();
    return await c.info();
  },

  async clearCache() {
    const { cache: c, views: vm } = requireReady();
    // Keep whatever is open, otherwise the user's tabs break under them.
    const keep = [...datasets.keys()];
    for (const id of keep) vm.forgetDataset(id);
    return await c.clear(keep);
  },

  async removeCacheEntry(params: { id: string }) {
    const { cache: c, views: vm } = requireReady();
    if (datasets.has(params.id)) {
      throw new EngineError(
        'invalid-request',
        'That file is open in a tab. Close the tab before removing its cache.',
      );
    }
    vm.forgetDataset(params.id);
    await c.removeEntry(params.id);
    return { ok: true };
  },

  setCacheLimit(params: { bytes: number }) {
    const { cache: c } = requireReady();
    c.setLimit(Math.max(1024 * 1024 * 512, Math.floor(params.bytes)));
    void c.prune([...datasets.keys()]).catch(() => {});
    return { ok: true };
  },

  async clearViews(params: { datasetId: string }) {
    const { cache: c, views: vm } = requireReady();
    vm.forgetDataset(params.datasetId);
    await c.clearViews(params.datasetId);
    return { ok: true };
  },

  cancel(params: { jobId: string }) {
    const { db: d } = requireReady();
    let cancelled = 0;
    for (const id of d.activeJobs()) {
      if (id === params.jobId || id.startsWith(`${params.jobId}-`)) {
        if (d.cancel(id)) cancelled++;
      }
    }
    return { ok: true, cancelled };
  },

  async parquetOf(params: { datasetId: string }) {
    const m = dataset(params.datasetId);
    return { path: m.parquetPath, sql: `read_parquet(${quotePath(m.parquetPath)})`, rowNum: PARQUET_ROWNUM };
  },
};

/* ------------------------------------------------------------------ dispatch */

transport.onMessage((raw) => {
  const msg = raw as RpcRequest;
  if (!msg || typeof msg.id !== 'number' || typeof msg.method !== 'string') return;
  const handler = handlers[msg.method];
  if (!handler) {
    const response: RpcResponse = {
      id: msg.id,
      ok: false,
      error: { code: 'invalid-request', message: `Unknown engine method: ${msg.method}` },
    };
    transport.send(response);
    return;
  }
  void (async () => {
    try {
      const result = await handler(msg.params ?? {});
      transport.send({ id: msg.id, ok: true, result } satisfies RpcResponse);
    } catch (err) {
      const e = err instanceof EngineError ? err : mapDuckError(err);
      transport.send({ id: msg.id, ok: false, error: e.toShape() } satisfies RpcResponse);
    }
  })();
});

process.on('uncaughtException', (err) => {
  log('error', `Engine crashed: ${err.message}`);
  // Let the parent notice the exit and restart us; continuing with a corrupted
  // DuckDB state would be worse than a restart.
  setTimeout(() => process.exit(1), 50);
});

process.on('unhandledRejection', (reason) => {
  log('error', `Unhandled engine error: ${String(reason)}`);
});

log('info', 'Engine host started.');

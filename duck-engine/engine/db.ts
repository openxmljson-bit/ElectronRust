/**
 * DuckDB lifecycle: one instance, a small pool of connections for interactive
 * queries, and one dedicated connection per long-running job so that
 * cancelling an ingest cannot interrupt the query painting the grid.
 */

import { cpus, totalmem } from 'node:os';
import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBResultReader } from '@duckdb/node-api';
import type { EngineErrorCode, EngineErrorShape } from '../shared/protocol.js';

export interface DbConfig {
  tempDir: string;
  memoryLimitMb: number | null;
  threads: number | null;
  maxTempBytes: number;
  /** Trading row order for speed is opt-in per ingest, so the default stays on. */
  preserveInsertionOrder: boolean;
}

export class EngineError extends Error {
  readonly code: EngineErrorCode;
  readonly hint: string | undefined;
  readonly detail: string | undefined;

  constructor(code: EngineErrorCode, message: string, hint?: string, detail?: string) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    this.hint = hint;
    this.detail = detail;
  }

  toShape(): EngineErrorShape {
    const shape: EngineErrorShape = { code: this.code, message: this.message };
    if (this.hint) shape.hint = this.hint;
    if (this.detail) shape.detail = this.detail;
    return shape;
  }
}

/** Turn a DuckDB error into something a person can act on. */
export function mapDuckError(err: unknown, context?: string): EngineError {
  const raw = err instanceof Error ? err.message : String(err);
  const msg = raw.replace(/\s+/g, ' ').trim();
  const withCtx = context ? `${context}: ${msg}` : msg;

  if (/INTERRUPT|Interrupted/i.test(msg)) {
    return new EngineError('cancelled', 'Cancelled.', undefined, msg);
  }
  if (/Out of Memory|OutOfMemoryException|failed to allocate/i.test(msg)) {
    return new EngineError(
      'out-of-memory',
      'The engine ran out of memory for this operation.',
      'Raise the memory limit in Settings, or turn on "Unordered fast ingest" which needs far less memory.',
      msg,
    );
  }
  if (/No space left|disk quota|temp directory.*size|max_temp_directory_size/i.test(msg)) {
    return new EngineError(
      'disk-full',
      'Ran out of disk space while working.',
      'Free space on the cache drive, or lower the cache limit and clear old entries in the Cache Manager.',
      msg,
    );
  }
  if (/Malformed JSON|Invalid Input Error.*JSON/i.test(msg)) {
    return new EngineError(
      'parse-failed',
      'The file contains JSON the parser could not read.',
      'Try again with "Skip malformed records" enabled, or open it as raw lines to find the bad record.',
      msg,
    );
  }
  if (/CSV Error|Value with unterminated quote|sniffing file|dialect/i.test(msg)) {
    return new EngineError(
      'parse-failed',
      'The delimited file did not parse cleanly.',
      'Set the delimiter and quote character explicitly, or enable "Read every column as text".',
      msg,
    );
  }
  if (/not utf-8|Invalid unicode/i.test(msg)) {
    return new EngineError(
      'parse-failed',
      'The file is not UTF-8 encoded.',
      'Pick the right encoding (Latin-1 or UTF-16) in Advanced options.',
      msg,
    );
  }
  if (/No files found|IO Error.*No such file|Cannot open file/i.test(msg)) {
    return new EngineError('not-found', 'The file could not be opened.', undefined, msg);
  }
  if (/Binder Error|Parser Error|Catalog Error/i.test(msg)) {
    return new EngineError('invalid-request', withCtx, undefined, msg);
  }
  return new EngineError('internal', withCtx, undefined, msg);
}

interface JobEntry {
  connection: DuckDBConnection;
  cancelled: boolean;
  startedAt: number;
}

export class EngineDb {
  private instance: DuckDBInstance | null = null;
  private pool: DuckDBConnection[] = [];
  private waiters: ((c: DuckDBConnection) => void)[] = [];
  private jobs = new Map<string, JobEntry>();
  private config: DbConfig | null = null;
  private resolvedMemoryLimit = '';
  private resolvedThreads = 0;

  async init(config: DbConfig): Promise<void> {
    this.config = config;
    const threads = config.threads ?? Math.max(2, Math.min(cpus().length, 16));
    const memMb =
      config.memoryLimitMb ??
      Math.max(1024, Math.floor((totalmem() / (1024 * 1024)) * 0.6));

    this.resolvedMemoryLimit = `${memMb}MB`;
    this.resolvedThreads = threads;

    this.instance = await DuckDBInstance.create(':memory:', {
      threads: String(threads),
      memory_limit: this.resolvedMemoryLimit,
      temp_directory: config.tempDir,
      max_temp_directory_size: `${Math.floor(config.maxTempBytes / (1024 * 1024))}MB`,
      preserve_insertion_order: config.preserveInsertionOrder ? 'true' : 'false',
      errors_as_json: 'false',
    });

    const poolSize = 4;
    for (let i = 0; i < poolSize; i++) {
      this.pool.push(await this.newConnection());
    }
  }

  private async newConnection(): Promise<DuckDBConnection> {
    if (!this.instance) throw new EngineError('engine-down', 'Engine is not initialised.');
    const conn = await this.instance.connect();
    // Progress tracking is a session setting, not an instance one: it has to be
    // switched on per connection for `connection.progress` to report anything,
    // and its terminal drawing must be off inside a windowed app.
    await conn.run(`SET enable_progress_bar=true`);
    await conn.run(`SET enable_progress_bar_print=false`);
    await conn.run(`SET progress_bar_time=0`);
    return conn;
  }

  get memoryLimit(): string {
    return this.resolvedMemoryLimit;
  }
  get threads(): number {
    return this.resolvedThreads;
  }
  get tempDir(): string {
    return this.config?.tempDir ?? '';
  }

  private async acquire(): Promise<DuckDBConnection> {
    const free = this.pool.pop();
    if (free) return free;
    return await new Promise<DuckDBConnection>((resolve) => this.waiters.push(resolve));
  }

  private release(conn: DuckDBConnection): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(conn);
    else this.pool.push(conn);
  }

  /** Short, interactive query. Never cancellable — keep these bounded by LIMIT. */
  async query(sql: string, context?: string): Promise<DuckDBResultReader> {
    const conn = await this.acquire();
    try {
      return await conn.runAndReadAll(sql);
    } catch (err) {
      throw mapDuckError(err, context);
    } finally {
      this.release(conn);
    }
  }

  async exec(sql: string, context?: string): Promise<void> {
    const conn = await this.acquire();
    try {
      await conn.run(sql);
    } catch (err) {
      throw mapDuckError(err, context);
    } finally {
      this.release(conn);
    }
  }

  async queryRows(sql: string, context?: string): Promise<(string | null)[][]> {
    const reader = await this.query(sql, context);
    return reader.getRowsJson().map((row) =>
      row.map((v) => (v === null || v === undefined ? null : typeof v === 'string' ? v : JSON.stringify(v))),
    );
  }

  async queryOneRow(sql: string, context?: string): Promise<(string | null)[] | null> {
    const rows = await this.queryRows(sql, context);
    return rows[0] ?? null;
  }

  async queryScalar(sql: string, context?: string): Promise<string | null> {
    const row = await this.queryOneRow(sql, context);
    return row ? (row[0] ?? null) : null;
  }

  /**
   * Run a statement on its own connection so it can be interrupted, polling
   * DuckDB's progress while it runs.
   */
  async runJob(
    jobId: string,
    sql: string | string[],
    onProgress?: (percent: number | null, rowsDone: number | null, rowsTotal: number | null) => void,
    context?: string,
  ): Promise<void> {
    if (!this.instance) throw new EngineError('engine-down', 'Engine is not initialised.');
    const existing = this.jobs.get(jobId);
    if (existing) {
      throw new EngineError('invalid-request', `Job ${jobId} is already running.`);
    }
    const connection = await this.newConnection();
    const entry: JobEntry = { connection, cancelled: false, startedAt: Date.now() };
    this.jobs.set(jobId, entry);

    let timer: NodeJS.Timeout | null = null;
    if (onProgress) {
      timer = setInterval(() => {
        try {
          const p = connection.progress;
          const pct = typeof p.percentage === 'number' && p.percentage >= 0 ? p.percentage : null;
          const done = p.rows_processed !== undefined ? Number(p.rows_processed) : null;
          const total =
            p.total_rows_to_process !== undefined ? Number(p.total_rows_to_process) : null;
          onProgress(pct, done, total && total > 0 ? total : null);
        } catch {
          /* progress is best-effort */
        }
      }, 250);
      if (typeof timer.unref === 'function') timer.unref();
    }

    try {
      for (const stmt of Array.isArray(sql) ? sql : [sql]) {
        await connection.run(stmt);
        if (entry.cancelled) throw new EngineError('cancelled', 'Cancelled.');
      }
    } catch (err) {
      if (entry.cancelled) throw new EngineError('cancelled', 'Cancelled.');
      throw mapDuckError(err, context);
    } finally {
      if (timer) clearInterval(timer);
      this.jobs.delete(jobId);
      try {
        connection.closeSync();
      } catch {
        /* already gone */
      }
    }
  }

  /** Like runJob, but returns rows (bounded — do not use for unbounded results). */
  async runJobRows(
    jobId: string,
    sql: string | string[],
    onProgress?: (percent: number | null, rowsDone: number | null, rowsTotal: number | null) => void,
    context?: string,
  ): Promise<(string | null)[][]> {
    if (!this.instance) throw new EngineError('engine-down', 'Engine is not initialised.');
    if (this.jobs.has(jobId)) throw new EngineError('invalid-request', `Job ${jobId} is running.`);
    const connection = await this.newConnection();
    const entry: JobEntry = { connection, cancelled: false, startedAt: Date.now() };
    this.jobs.set(jobId, entry);
    let timer: NodeJS.Timeout | null = null;
    if (onProgress) {
      timer = setInterval(() => {
        try {
          const p = connection.progress;
          const pct = typeof p.percentage === 'number' && p.percentage >= 0 ? p.percentage : null;
          onProgress(
            pct,
            p.rows_processed !== undefined ? Number(p.rows_processed) : null,
            p.total_rows_to_process !== undefined ? Number(p.total_rows_to_process) : null,
          );
        } catch {
          /* best effort */
        }
      }, 250);
      if (typeof timer.unref === 'function') timer.unref();
    }
    try {
      const stmts = Array.isArray(sql) ? sql : [sql];
      for (const stmt of stmts.slice(0, -1)) await connection.run(stmt);
      const last = stmts[stmts.length - 1]!;
      const reader = await connection.runAndReadAll(last);
      if (entry.cancelled) throw new EngineError('cancelled', 'Cancelled.');
      return reader
        .getRowsJson()
        .map((row) =>
          row.map((v) =>
            v === null || v === undefined ? null : typeof v === 'string' ? v : JSON.stringify(v),
          ),
        );
    } catch (err) {
      if (entry.cancelled) throw new EngineError('cancelled', 'Cancelled.');
      throw mapDuckError(err, context);
    } finally {
      if (timer) clearInterval(timer);
      this.jobs.delete(jobId);
      try {
        connection.closeSync();
      } catch {
        /* already gone */
      }
    }
  }

  cancel(jobId: string): boolean {
    const entry = this.jobs.get(jobId);
    if (!entry) return false;
    entry.cancelled = true;
    try {
      entry.connection.interrupt();
    } catch {
      /* the query may have finished between the check and here */
    }
    return true;
  }

  cancelAll(): void {
    for (const id of [...this.jobs.keys()]) this.cancel(id);
  }

  activeJobs(): string[] {
    return [...this.jobs.keys()];
  }

  close(): void {
    this.cancelAll();
    for (const c of this.pool) {
      try {
        c.closeSync();
      } catch {
        /* shutting down */
      }
    }
    this.pool = [];
    this.instance = null;
  }
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

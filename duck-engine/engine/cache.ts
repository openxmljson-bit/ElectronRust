/**
 * On-disk cache. Each source file becomes one directory holding a Parquet
 * rendering of the file, a manifest describing it, and any derived (sorted or
 * filtered) Parquet files built from it.
 *
 *   <root>/datasets/<id>/manifest.json
 *   <root>/datasets/<id>/base.parquet
 *   <root>/datasets/<id>/views/<viewKey>.parquet
 *   <root>/tmp/            DuckDB spill directory
 *   <root>/exports/        scratch space for exports
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  CacheEntrySummary,
  CacheInfo,
  DatasetManifest,
  OpenOptions,
} from '../shared/protocol.js';

export const MANIFEST_VERSION = 3;

export interface CachePaths {
  root: string;
  datasets: string;
  tmp: string;
  exports: string;
}

export class DatasetCache {
  readonly paths: CachePaths;
  private limitBytes: number;
  private lastUsed = new Map<string, number>();

  constructor(root: string, limitBytes: number) {
    this.paths = {
      root,
      datasets: join(root, 'datasets'),
      tmp: join(root, 'tmp'),
      exports: join(root, 'exports'),
    };
    this.limitBytes = limitBytes;
  }

  async init(): Promise<void> {
    await mkdir(this.paths.datasets, { recursive: true });
    await mkdir(this.paths.tmp, { recursive: true });
    await mkdir(this.paths.exports, { recursive: true });
    // Anything left in tmp/exports is from a process that died; it is never needed again.
    await this.emptyDir(this.paths.tmp);
    await this.emptyDir(this.paths.exports);
    await this.loadUsage();
  }

  private async emptyDir(dir: string): Promise<void> {
    try {
      const names = await readdir(dir);
      await Promise.all(names.map((n) => rm(join(dir, n), { recursive: true, force: true })));
    } catch {
      /* first run */
    }
  }

  setLimit(bytes: number): void {
    this.limitBytes = bytes;
  }

  getLimit(): number {
    return this.limitBytes;
  }

  /** Identity of a cache entry: the file as it is now, plus the options used to read it. */
  datasetId(path: string, size: number, mtimeMs: number, options: OpenOptions): string {
    const fingerprint = JSON.stringify({
      format: options.format ?? null,
      delimiter: options.delimiter ?? null,
      quote: options.quote ?? null,
      escape: options.escape ?? null,
      hasHeader: options.hasHeader ?? null,
      hasHeaderExplicit: !!options.hasHeaderExplicit,
      encoding: options.encoding ?? null,
      allVarchar: !!options.allVarchar,
      ignoreErrors: !!options.ignoreErrors,
      nullPadding: options.nullPadding !== false,
      sampleSize: options.sampleSize ?? null,
      flatten: !!options.flatten,
      columnTypes: options.columnTypes ?? null,
    });
    return createHash('sha1')
      .update(path)
      .update(String(size))
      .update(String(Math.round(mtimeMs)))
      .update(fingerprint)
      .digest('hex')
      .slice(0, 20);
  }

  dir(id: string): string {
    return join(this.paths.datasets, id);
  }
  basePath(id: string): string {
    return join(this.dir(id), 'base.parquet');
  }
  manifestPath(id: string): string {
    return join(this.dir(id), 'manifest.json');
  }
  viewsDir(id: string): string {
    return join(this.dir(id), 'views');
  }
  viewPath(id: string, key: string): string {
    return join(this.viewsDir(id), `${key}.parquet`);
  }

  async prepareDir(id: string): Promise<void> {
    await mkdir(this.viewsDir(id), { recursive: true });
  }

  async readManifest(id: string): Promise<DatasetManifest | null> {
    try {
      const raw = await readFile(this.manifestPath(id), 'utf8');
      const m = JSON.parse(raw) as DatasetManifest;
      if (m.version !== MANIFEST_VERSION) return null;
      if (!existsSync(m.parquetPath)) return null;
      return m;
    } catch {
      return null;
    }
  }

  async writeManifest(m: DatasetManifest): Promise<void> {
    await this.prepareDir(m.id);
    await writeJsonAtomic(this.manifestPath(m.id), m);
    this.touch(m.id);
  }

  /**
   * A cached entry is only reusable when the source file has not changed. Size
   * and mtime are already folded into the id, so an id hit plus a present
   * Parquet file is sufficient — but we re-check the source to catch the case
   * where the file was replaced by one of identical size and timestamp.
   */
  async findReusable(
    path: string,
    size: number,
    mtimeMs: number,
    options: OpenOptions,
  ): Promise<DatasetManifest | null> {
    if (options.forceReingest) return null;
    const id = this.datasetId(path, size, mtimeMs, options);
    const m = await this.readManifest(id);
    if (!m) return null;
    if (m.sourceSize !== size || Math.round(m.sourceMtimeMs) !== Math.round(mtimeMs)) return null;
    this.touch(id);
    return m;
  }

  touch(id: string): void {
    this.lastUsed.set(id, Date.now());
    void this.saveUsage();
  }

  private usagePath(): string {
    return join(this.paths.root, 'usage.json');
  }

  private async loadUsage(): Promise<void> {
    try {
      const raw = await readFile(this.usagePath(), 'utf8');
      const obj = JSON.parse(raw) as Record<string, number>;
      this.lastUsed = new Map(Object.entries(obj));
    } catch {
      this.lastUsed = new Map();
    }
  }

  private saveTimer: NodeJS.Timeout | null = null;
  private async saveUsage(): Promise<void> {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void writeJsonAtomic(this.usagePath(), Object.fromEntries(this.lastUsed)).catch(() => {});
    }, 2000);
    if (typeof this.saveTimer.unref === 'function') this.saveTimer.unref();
  }

  async removeEntry(id: string): Promise<void> {
    await rm(this.dir(id), { recursive: true, force: true });
    this.lastUsed.delete(id);
    void this.saveUsage();
  }

  async info(): Promise<CacheInfo> {
    const entries: CacheEntrySummary[] = [];
    let total = 0;
    let ids: string[] = [];
    try {
      ids = await readdir(this.paths.datasets);
    } catch {
      ids = [];
    }
    for (const id of ids) {
      const m = await this.readManifest(id);
      if (!m) {
        // Orphaned directory (interrupted ingest): count its bytes so the user
        // can see and clear it.
        const bytes = await dirSize(this.dir(id));
        total += bytes;
        continue;
      }
      const parquetBytes = await fileSize(m.parquetPath);
      const derivedBytes = await dirSize(this.viewsDir(id));
      total += parquetBytes + derivedBytes;
      let sourceMissing = false;
      let stale = false;
      try {
        const st = await stat(m.sourcePath);
        stale = st.size !== m.sourceSize || Math.round(st.mtimeMs) !== Math.round(m.sourceMtimeMs);
      } catch {
        sourceMissing = true;
      }
      entries.push({
        id,
        sourceName: m.sourceName,
        sourcePath: m.sourcePath,
        sourceSize: m.sourceSize,
        parquetBytes,
        derivedBytes,
        rowCount: m.rowCount,
        ingestedAtMs: m.ingestedAtMs,
        lastUsedMs: this.lastUsed.get(id) ?? m.ingestedAtMs,
        sourceMissing,
        stale,
      });
    }
    entries.sort((a, b) => b.lastUsedMs - a.lastUsedMs);
    return { dir: this.paths.root, totalBytes: total, limitBytes: this.limitBytes, entries };
  }

  async clear(keepIds: Iterable<string> = []): Promise<{ removed: number; bytes: number }> {
    const keep = new Set(keepIds);
    const info = await this.info();
    let removed = 0;
    let bytes = 0;
    let ids: string[] = [];
    try {
      ids = await readdir(this.paths.datasets);
    } catch {
      return { removed: 0, bytes: 0 };
    }
    for (const id of ids) {
      if (keep.has(id)) continue;
      const entry = info.entries.find((e) => e.id === id);
      bytes += entry ? entry.parquetBytes + entry.derivedBytes : await dirSize(this.dir(id));
      await this.removeEntry(id);
      removed++;
    }
    return { removed, bytes };
  }

  /** Delete least-recently-used entries until the cache fits its limit. */
  async prune(protectedIds: Iterable<string> = []): Promise<{ removed: number; bytes: number }> {
    const keep = new Set(protectedIds);
    const info = await this.info();
    if (info.totalBytes <= this.limitBytes) return { removed: 0, bytes: 0 };
    const candidates = info.entries
      .filter((e) => !keep.has(e.id))
      .sort((a, b) => a.lastUsedMs - b.lastUsedMs);
    let total = info.totalBytes;
    let removed = 0;
    let bytes = 0;
    for (const c of candidates) {
      if (total <= this.limitBytes) break;
      const size = c.parquetBytes + c.derivedBytes;
      await this.removeEntry(c.id);
      total -= size;
      bytes += size;
      removed++;
    }
    return { removed, bytes };
  }

  /** Remove derived view Parquet files for a dataset, keeping the base. */
  async clearViews(id: string): Promise<void> {
    await rm(this.viewsDir(id), { recursive: true, force: true });
    await mkdir(this.viewsDir(id), { recursive: true });
  }
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await rename(tmp, path);
}

export async function fileSize(path: string): Promise<number> {
  try {
    const st = await stat(path);
    return st.size;
  } catch {
    return 0;
  }
}

export async function dirSize(dir: string): Promise<number> {
  let total = 0;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  for (const n of names) {
    const p = join(dir, n);
    try {
      const st = await stat(p);
      total += st.isDirectory() ? await dirSize(p) : st.size;
    } catch {
      /* raced with a delete */
    }
  }
  return total;
}

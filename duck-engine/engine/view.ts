/**
 * Views.
 *
 * A view is a dataset plus filters, a search and a sort. Any non-trivial view is
 * written out as its own Parquet file once, after which every page of it is a
 * row-group-pruned read that costs the same whether the user is on row 10 or row
 * 190 million. That single decision is what keeps the UI responsive on a 20 GB
 * file: there is no query path whose cost grows with scroll position.
 */

import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import type {
  ColumnInfo,
  DatasetManifest,
  PageRequest,
  PageResult,
  ViewInfo,
  ViewSpec,
} from '../shared/protocol.js';
import { DatasetCache, fileSize } from './cache.js';
import { EngineDb, EngineError } from './db.js';
import {
  PARQUET_ROWNUM,
  SOURCE_ROWNUM,
  displayExpr,
  isIdentityView,
  orderByClause,
  quoteIdent,
  quotePath,
  searchExpr,
  selectedColumns,
  viewKey,
  whereClause,
} from './sql.js';

const ROW_GROUP_SIZE = 122_880;

export interface ResolvedView {
  key: string;
  datasetId: string;
  identity: boolean;
  materialized: boolean;
  /** Parquet file backing this view. */
  path: string;
  columns: ColumnInfo[];
  rowCount: number;
  buildMs: number;
  /** Expression giving the row's position within the view. */
  rowNumExpr: string;
  /** Expression giving the row's line number in the original file. */
  sourceRowExpr: string;
}

export interface MaterializeProgress {
  phase: string;
  percent: number | null;
  rowsDone: number | null;
}

export class ViewManager {
  private resolved = new Map<string, ResolvedView>();
  private building = new Map<string, Promise<ResolvedView>>();

  constructor(
    private readonly db: EngineDb,
    private readonly cache: DatasetCache,
  ) {}

  /** Drop cached knowledge of a dataset's views (not the files). */
  forgetDataset(datasetId: string): void {
    for (const [key, v] of [...this.resolved]) {
      if (v.datasetId === datasetId) this.resolved.delete(key);
    }
  }

  async resolve(
    manifest: DatasetManifest,
    view: ViewSpec,
    jobId: string,
    onProgress?: (p: MaterializeProgress) => void,
  ): Promise<ResolvedView> {
    const columns = selectedColumns(view, manifest.columns);
    const key = viewKey(manifest.id, view, columns);

    const cached = this.resolved.get(key);
    if (cached && existsSync(cached.path)) return cached;

    const inFlight = this.building.get(key);
    if (inFlight) return await inFlight;

    const task = this.build(manifest, view, columns, key, jobId, onProgress).finally(() => {
      this.building.delete(key);
    });
    this.building.set(key, task);
    return await task;
  }

  private async build(
    manifest: DatasetManifest,
    view: ViewSpec,
    columns: ColumnInfo[],
    key: string,
    jobId: string,
    onProgress?: (p: MaterializeProgress) => void,
  ): Promise<ResolvedView> {
    const started = Date.now();
    const identity = isIdentityView(view) && columns.length === manifest.columns.length;

    if (identity) {
      const resolved: ResolvedView = {
        key,
        datasetId: manifest.id,
        identity: true,
        materialized: false,
        path: manifest.parquetPath,
        columns,
        rowCount: manifest.rowCount,
        buildMs: 0,
        rowNumExpr: PARQUET_ROWNUM,
        sourceRowExpr: PARQUET_ROWNUM,
      };
      this.resolved.set(key, resolved);
      return resolved;
    }

    const outPath = this.cache.viewPath(manifest.id, key);

    // A derived Parquet from a previous session is still valid: the base file is
    // content-addressed, so identical inputs give identical output.
    if (existsSync(outPath)) {
      const rowCount = await this.parquetRows(outPath);
      const resolved: ResolvedView = {
        key,
        datasetId: manifest.id,
        identity: false,
        materialized: true,
        path: outPath,
        columns,
        rowCount,
        buildMs: 0,
        rowNumExpr: PARQUET_ROWNUM,
        sourceRowExpr: SOURCE_ROWNUM,
      };
      this.resolved.set(key, resolved);
      return resolved;
    }

    await this.cache.prepareDir(manifest.id);
    const tmp = `${outPath}.building`;
    await rm(tmp, { force: true });

    const where = whereClause(view, manifest.columns);
    const order = orderByClause(view.sort, manifest.columns);
    const projected = columns.map((c) => quoteIdent(c.name)).join(', ');

    const inner = `SELECT ${PARQUET_ROWNUM} AS ${quoteIdent(SOURCE_ROWNUM)}, ${projected}
      FROM read_parquet(${quotePath(manifest.parquetPath)}, ${PARQUET_ROWNUM}=true)
      ${where ? `WHERE ${where}` : ''}
      ${order ? `ORDER BY ${order}` : ''}`;

    const copySql = `COPY (${inner}) TO ${quotePath(tmp)} (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE ${ROW_GROUP_SIZE})`;

    try {
      await this.db.runJob(
        jobId,
        ['SET preserve_insertion_order=true', copySql],
        (percent, rowsDone) => {
          onProgress?.({
            phase: order ? 'Sorting rows' : 'Selecting rows',
            percent,
            rowsDone,
          });
        },
        'building the view',
      );
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }

    const { rename } = await import('node:fs/promises');
    await rename(tmp, outPath);

    const rowCount = await this.parquetRows(outPath);
    const resolved: ResolvedView = {
      key,
      datasetId: manifest.id,
      identity: false,
      materialized: true,
      path: outPath,
      columns,
      rowCount,
      buildMs: Date.now() - started,
      rowNumExpr: PARQUET_ROWNUM,
      sourceRowExpr: SOURCE_ROWNUM,
    };
    this.resolved.set(key, resolved);
    this.cache.touch(manifest.id);
    return resolved;
  }

  private async parquetRows(path: string): Promise<number> {
    const v = await this.db.queryScalar(
      `SELECT coalesce(sum(num_rows), 0)::BIGINT FROM parquet_file_metadata(${quotePath(path)})`,
      'counting view rows',
    );
    return Number(v ?? '0');
  }

  info(resolved: ResolvedView): ViewInfo {
    return {
      key: resolved.key,
      datasetId: resolved.datasetId,
      rowCount: resolved.rowCount,
      materialized: resolved.materialized,
      columns: resolved.columns,
      buildMs: resolved.buildMs,
      identity: resolved.identity,
    };
  }

  /** The table expression to read a resolved view from, exposing row numbers. */
  relation(resolved: ResolvedView): string {
    return `read_parquet(${quotePath(resolved.path)}, ${PARQUET_ROWNUM}=true)`;
  }

  async page(
    manifest: DatasetManifest,
    req: PageRequest,
    resolved: ResolvedView,
  ): Promise<PageResult> {
    const started = Date.now();
    const maxCellChars = Math.max(16, Math.min(req.maxCellChars ?? 2000, 200_000));
    const offset = Math.max(0, Math.floor(req.offset));
    const limit = Math.max(1, Math.min(Math.floor(req.limit), 5000));
    const end = offset + limit;

    if (offset >= resolved.rowCount) {
      return {
        viewKey: resolved.key,
        offset,
        columns: resolved.columns,
        rows: [],
        sourceRows: [],
        totalRows: resolved.rowCount,
        truncated: false,
        elapsedMs: Date.now() - started,
      };
    }

    const display = resolved.columns.map((c) => displayExpr(c, maxCellChars)).join(',\n  ');
    const sql = `SELECT
  ${resolved.sourceRowExpr} AS ${quoteIdent('__source_row')},
  ${display}
FROM ${this.relation(resolved)}
WHERE ${PARQUET_ROWNUM} >= ${offset} AND ${PARQUET_ROWNUM} < ${end}
ORDER BY ${PARQUET_ROWNUM}`;

    const rows = await this.db.queryRows(sql, 'reading rows');
    let truncated = false;
    const sourceRows: number[] = [];
    const cells: (string | null)[][] = [];
    for (const row of rows) {
      const sr = row[0];
      sourceRows.push(sr === null || sr === undefined ? -1 : Number(sr));
      const rest = row.slice(1);
      for (const cell of rest) {
        if (cell !== null && cell.endsWith('…')) truncated = true;
      }
      cells.push(rest);
    }

    return {
      viewKey: resolved.key,
      offset,
      columns: resolved.columns,
      rows: cells,
      sourceRows,
      totalRows: resolved.rowCount,
      truncated,
      elapsedMs: Date.now() - started,
    };
  }

  /** Full, untruncated JSON for one row — what the inspector shows. */
  async rowJson(
    resolved: ResolvedView,
    viewRow: number,
  ): Promise<{ json: string; sourceRow: number }> {
    if (viewRow < 0 || viewRow >= resolved.rowCount) {
      throw new EngineError('invalid-request', `Row ${viewRow} is outside this view.`);
    }
    const cols = resolved.columns.map((c) => quoteIdent(c.name)).join(', ');
    const sql = `SELECT to_json(t)::VARCHAR AS j, t.${resolved.sourceRowExpr} AS sr
      FROM (
        SELECT ${resolved.sourceRowExpr}, ${cols}
        FROM ${this.relation(resolved)}
        WHERE ${PARQUET_ROWNUM} = ${Math.floor(viewRow)}
      ) t`;
    const row = await this.db.queryOneRow(sql, 'reading a row');
    if (!row) throw new EngineError('not-found', `Row ${viewRow} not found.`);
    let json = row[0] ?? '{}';
    // Strip the internal row-number field so the inspector shows only real data.
    try {
      const parsed = JSON.parse(json) as Record<string, unknown>;
      delete parsed[SOURCE_ROWNUM];
      delete parsed[PARQUET_ROWNUM];
      json = JSON.stringify(parsed, null, 2);
    } catch {
      /* leave as-is */
    }
    return { json, sourceRow: Number(row[1] ?? -1) };
  }

  /** Step to the next (or previous) row matching the search, without filtering. */
  async findMatch(
    resolved: ResolvedView,
    search: ViewSpec['search'],
    fromViewRow: number,
    direction: 'next' | 'prev',
  ): Promise<number | null> {
    if (!search?.query) return null;
    const expr = searchExpr(search, resolved.columns);
    if (!expr) return null;
    const bound =
      direction === 'next'
        ? `${PARQUET_ROWNUM} > ${Math.floor(fromViewRow)}`
        : `${PARQUET_ROWNUM} < ${Math.floor(fromViewRow)}`;
    const agg = direction === 'next' ? 'min' : 'max';
    const sql = `SELECT ${agg}(${PARQUET_ROWNUM})::BIGINT
      FROM ${this.relation(resolved)}
      WHERE ${bound} AND ${expr}`;
    const v = await this.db.queryScalar(sql, 'searching');
    if (v === null) {
      // Wrap around to the other end.
      const wrapSql = `SELECT ${agg}(${PARQUET_ROWNUM})::BIGINT FROM ${this.relation(resolved)} WHERE ${expr}`;
      const w = await this.db.queryScalar(wrapSql, 'searching');
      return w === null ? null : Number(w);
    }
    return Number(v);
  }

  /** Total matches for a search inside a view, used for the "n of m" readout. */
  async countMatches(resolved: ResolvedView, search: ViewSpec['search']): Promise<number> {
    if (!search?.query) return 0;
    const expr = searchExpr(search, resolved.columns);
    if (!expr) return 0;
    const v = await this.db.queryScalar(
      `SELECT count(*)::BIGINT FROM ${this.relation(resolved)} WHERE ${expr}`,
      'counting matches',
    );
    return Number(v ?? '0');
  }

  async viewBytes(resolved: ResolvedView): Promise<number> {
    return await fileSize(resolved.path);
  }
}

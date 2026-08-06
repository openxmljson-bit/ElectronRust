/**
 * Data tools that sit on top of a resolved view: SQL console, JSON Schema
 * generate/validate, export/convert, and dataset diff.
 */

import type {
  DatasetManifest,
  DiffRequest,
  DiffResult,
  ExportFormat,
  ExportRequest,
  ExportResult,
  SqlResult,
} from '../shared/protocol.js';
import { fileSize } from './cache.js';
import { EngineDb, EngineError } from './db.js';
import {
  PARQUET_ROWNUM,
  assertReadOnlySql,
  limitWrap,
  quoteIdent,
  quotePath,
  textExpr,
} from './sql.js';
import type { ResolvedView } from './view.js';

const MAX_SELECTION_ROWS = 200_000;

/* ------------------------------------------------------------------ SQL ---- */

export class SqlConsole {
  constructor(private readonly db: EngineDb) {}

  /**
   * The console exposes the current view as `data` (and the untouched file as
   * `source`), so users write ordinary SQL without knowing where the Parquet
   * lives. Statements are checked to be read-only first.
   */
  async run(args: {
    sql: string;
    jobId: string;
    limit: number;
    view: ResolvedView | null;
    manifest: DatasetManifest | null;
  }): Promise<SqlResult> {
    const { sql, jobId, limit, view, manifest } = args;
    assertReadOnlySql(sql);
    const started = Date.now();

    const prelude: string[] = [];
    if (view) {
      prelude.push(
        `CREATE OR REPLACE TEMP VIEW data AS SELECT * EXCLUDE (${PARQUET_ROWNUM}) FROM read_parquet(${quotePath(
          view.path,
        )}, ${PARQUET_ROWNUM}=true)`,
      );
    }
    if (manifest) {
      prelude.push(
        `CREATE OR REPLACE TEMP VIEW source AS SELECT * FROM read_parquet(${quotePath(
          manifest.parquetPath,
        )})`,
      );
    }

    const wrapped = limitWrap(sql, limit + 1);
    // Temp views are per-connection, so they must be created on the job's own
    // connection; runJobRows executes the whole list there.
    const rows = await this.db.runJobRows(
      jobId,
      [...prelude, wrapped],
      undefined,
      'running your query',
    );

    // Column metadata comes from a zero-row describe of the same statement.
    let columns: { name: string; type: string }[] = [];
    try {
      const desc = await this.db.runJobRows(`${jobId}-describe`, [
        ...prelude,
        `DESCRIBE ${limitWrap(sql, 1)}`,
      ]);
      columns = desc.map((r) => ({ name: r[0] ?? '', type: r[1] ?? 'VARCHAR' }));
    } catch {
      const width = rows[0]?.length ?? 0;
      columns = Array.from({ length: width }, (_, i) => ({ name: `column${i}`, type: 'VARCHAR' }));
    }

    const truncated = rows.length > limit;
    return {
      columns,
      rows: truncated ? rows.slice(0, limit) : rows,
      rowCount: truncated ? limit : rows.length,
      truncatedAt: truncated ? limit : null,
      elapsedMs: Date.now() - started,
      executed: sql.trim(),
    };
  }
}

/* --------------------------------------------------------------- export ---- */

function copyOptions(format: ExportFormat, req: ExportRequest): string {
  const header = req.includeHeader !== false;
  const compression = req.compression && req.compression !== 'none' ? `, COMPRESSION ${req.compression}` : '';
  switch (format) {
    case 'csv':
      return `FORMAT csv, HEADER ${header}, DELIMITER '${(req.delimiter ?? ',').replace(/'/g, "''")}'${compression}`;
    case 'xlsx-csv':
      // Excel wants a BOM and CRLF to read UTF-8 reliably.
      return `FORMAT csv, HEADER ${header}, DELIMITER ',', WRITE_BOM true${compression}`;
    case 'tsv':
      return `FORMAT csv, HEADER ${header}, DELIMITER '\\t'${compression}`;
    case 'psv':
      return `FORMAT csv, HEADER ${header}, DELIMITER '|'${compression}`;
    case 'parquet':
      return `FORMAT parquet, COMPRESSION ${req.compression && req.compression !== 'none' ? req.compression : 'zstd'}`;
    default:
      return `FORMAT csv, HEADER ${header}`;
  }
}

export class Exporter {
  constructor(private readonly db: EngineDb) {}

  async run(args: {
    req: ExportRequest;
    view: ResolvedView;
    relation: string;
    jobId: string;
    onProgress?: (percent: number | null, rows: number | null) => void;
  }): Promise<ExportResult> {
    const { req, view, relation, jobId, onProgress } = args;
    const started = Date.now();

    const where: string[] = [];
    if (req.sourceRows && req.sourceRows.length > 0) {
      if (req.sourceRows.length > MAX_SELECTION_ROWS) {
        throw new EngineError(
          'invalid-request',
          `Too many selected rows to export (${req.sourceRows.length.toLocaleString()}).`,
          `Export at most ${MAX_SELECTION_ROWS.toLocaleString()} selected rows, or export the whole view instead.`,
        );
      }
      const ids = req.sourceRows.map((n) => Math.floor(n)).join(', ');
      where.push(`${PARQUET_ROWNUM} IN (${ids})`);
    }

    const cols = view.columns.map((c) => quoteIdent(c.name)).join(', ');
    const inner = `SELECT ${cols} FROM ${relation}
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY ${PARQUET_ROWNUM}
      ${req.limit ? `LIMIT ${Math.floor(req.limit)}` : ''}`;

    const sql = `COPY (${inner}) TO ${quotePath(req.targetPath)} (${copyOptions(req.format, req)})`;
    await this.db.runJob(jobId, ['SET preserve_insertion_order=true', sql], (p, rows) => onProgress?.(p, rows), 'exporting');

    const bytes = await fileSize(req.targetPath);
    const rowsWritten = await this.db
      .queryScalar(
        `SELECT count(*)::BIGINT FROM (${inner}) q`,
        'counting exported rows',
      )
      .then((v) => Number(v ?? 0))
      .catch(() => -1);

    return {
      targetPath: req.targetPath,
      rowsWritten,
      bytesWritten: bytes,
      elapsedMs: Date.now() - started,
    };
  }
}

/* ----------------------------------------------------------------- diff ---- */

export class Differ {
  constructor(private readonly db: EngineDb) {}

  async run(args: {
    req: DiffRequest;
    left: { relation: string; view: ResolvedView };
    right: { relation: string; view: ResolvedView };
    jobId: string;
    onProgress?: (percent: number | null) => void;
  }): Promise<DiffResult> {
    const started = Date.now();
    const { req, left, right, jobId, onProgress } = args;

    const leftNames = left.view.columns.map((c) => c.name);
    const rightNames = right.view.columns.map((c) => c.name);
    const shared = leftNames.filter((n) => rightNames.includes(n));
    const columnsOnlyLeft = leftNames.filter((n) => !rightNames.includes(n));
    const columnsOnlyRight = rightNames.filter((n) => !leftNames.includes(n));

    const compare = (req.compareColumns ?? shared).filter((n) => shared.includes(n));
    if (compare.length === 0) {
      throw new EngineError(
        'invalid-request',
        'These two datasets share no comparable columns.',
        'Pick columns explicitly, or check that both files loaded with the schema you expected.',
      );
    }

    const keys = req.keyColumns.filter((k) => shared.includes(k));
    const positional = keys.length === 0;

    const leftCols = left.view.columns.filter((c) => compare.includes(c.name));
    const rightCols = right.view.columns.filter((c) => compare.includes(c.name));

    const lSel = [
      positional ? `${PARQUET_ROWNUM} AS "__k0"` : keys.map((k, i) => `${textExpr(left.view.columns.find((c) => c.name === k)!)} AS ${quoteIdent(`__k${i}`)}`).join(', '),
      ...leftCols.map((c) => `${textExpr(c)} AS ${quoteIdent(`c_${c.name}`)}`),
    ].join(', ');
    const rSel = [
      positional ? `${PARQUET_ROWNUM} AS "__k0"` : keys.map((k, i) => `${textExpr(right.view.columns.find((c) => c.name === k)!)} AS ${quoteIdent(`__k${i}`)}`).join(', '),
      ...rightCols.map((c) => `${textExpr(c)} AS ${quoteIdent(`c_${c.name}`)}`),
    ].join(', ');

    const keyCount = positional ? 1 : keys.length;
    const lKey = (i: number) => quoteIdent(`__k${i}`);
    const rKey = (i: number) => quoteIdent(`__rk${i}`);
    const joinCond = Array.from(
      { length: keyCount },
      (_, i) => `l.${lKey(i)} IS NOT DISTINCT FROM r.${lKey(i)}`,
    ).join(' AND ');

    /** Human-readable key, taking whichever side is present. */
    const keyText = Array.from(
      { length: keyCount },
      (_, i) => `coalesce(${lKey(i)}::VARCHAR, ${rKey(i)}::VARCHAR, '∅')`,
    ).join(` || ' | ' || `);

    const changedPredicate = compare
      .map((n) => `(${quoteIdent(`c_${n}`)} IS DISTINCT FROM ${quoteIdent(`r_${n}`)})`)
      .join(' OR ');

    const prelude = [
      `CREATE OR REPLACE TEMP VIEW l AS SELECT ${lSel} FROM ${left.relation}`,
      `CREATE OR REPLACE TEMP VIEW r AS SELECT ${rSel} FROM ${right.relation}`,
      `CREATE OR REPLACE TEMP VIEW j AS SELECT
         ${Array.from({ length: keyCount }, (_, i) => `l.${lKey(i)} AS ${lKey(i)}`).join(', ')},
         ${Array.from({ length: keyCount }, (_, i) => `r.${lKey(i)} AS ${rKey(i)}`).join(', ')},
         ${compare.map((n) => `l.${quoteIdent(`c_${n}`)} AS ${quoteIdent(`c_${n}`)}`).join(', ')},
         ${compare.map((n) => `r.${quoteIdent(`c_${n}`)} AS ${quoteIdent(`r_${n}`)}`).join(', ')},
         (l.${lKey(0)} IS NULL) AS "__l_missing",
         (r.${lKey(0)} IS NULL) AS "__r_missing"
       FROM l FULL OUTER JOIN r ON ${joinCond}`,
    ];

    const summarySql = `SELECT
      (SELECT count(*)::BIGINT FROM l) AS left_rows,
      (SELECT count(*)::BIGINT FROM r) AS right_rows,
      sum(CASE WHEN "__r_missing" THEN 1 ELSE 0 END)::BIGINT AS only_left,
      sum(CASE WHEN "__l_missing" THEN 1 ELSE 0 END)::BIGINT AS only_right,
      sum(CASE WHEN NOT "__l_missing" AND NOT "__r_missing" AND (${changedPredicate}) THEN 1 ELSE 0 END)::BIGINT AS changed,
      sum(CASE WHEN NOT "__l_missing" AND NOT "__r_missing" AND NOT (${changedPredicate}) THEN 1 ELSE 0 END)::BIGINT AS identical
      FROM j`;

    onProgress?.(null);
    const summary = await this.db.runJobRows(
      jobId,
      [...prelude, summarySql],
      (p) => onProgress?.(p),
      'comparing datasets',
    );
    const s = summary[0] ?? [];

    const perColumnSql = `SELECT ${compare
      .map(
        (n) =>
          `sum(CASE WHEN NOT "__l_missing" AND NOT "__r_missing" AND (${quoteIdent(`c_${n}`)} IS DISTINCT FROM ${quoteIdent(
            `r_${n}`,
          )}) THEN 1 ELSE 0 END)::BIGINT`,
      )
      .join(', ')} FROM j`;
    const perColumn = await this.db.runJobRows(`${jobId}-cols`, [...prelude, perColumnSql]);
    const columnStats = compare.map((n, i) => ({ column: n, changed: Number(perColumn[0]?.[i] ?? 0) }));

    const maxEx = Math.max(1, Math.min(req.maxExamples, 500));
    const exampleSql = `SELECT
        CASE WHEN "__r_missing" THEN 'only-left' WHEN "__l_missing" THEN 'only-right' ELSE 'changed' END AS kind,
        ${keyText} AS key_text,
        ${compare.map((n) => quoteIdent(`c_${n}`)).join(', ')},
        ${compare.map((n) => quoteIdent(`r_${n}`)).join(', ')}
      FROM j
      WHERE "__l_missing" OR "__r_missing" OR (${changedPredicate})
      ORDER BY kind, key_text
      LIMIT ${maxEx}`;

    let examples: DiffResult['examples'] = [];
    try {
      const rows = await this.db.runJobRows(`${jobId}-examples`, [...prelude, exampleSql]);
      examples = rows.map((r) => {
        const kind = (r[0] ?? 'changed') as DiffResult['examples'][number]['kind'];
        const key = r[1] ?? '';
        const leftVals: Record<string, string | null> = {};
        const rightVals: Record<string, string | null> = {};
        compare.forEach((n, i) => {
          leftVals[n] = r[2 + i] ?? null;
          rightVals[n] = r[2 + compare.length + i] ?? null;
        });
        const changedColumns = compare.filter((n) => leftVals[n] !== rightVals[n]);
        return {
          kind,
          key,
          left: kind === 'only-right' ? null : leftVals,
          right: kind === 'only-left' ? null : rightVals,
          changedColumns,
        };
      });
    } catch {
      examples = [];
    }

    return {
      leftRows: Number(s[0] ?? 0),
      rightRows: Number(s[1] ?? 0),
      onlyLeft: Number(s[2] ?? 0),
      onlyRight: Number(s[3] ?? 0),
      changed: Number(s[4] ?? 0),
      identical: Number(s[5] ?? 0),
      columnsOnlyLeft,
      columnsOnlyRight,
      columnStats,
      examples,
      elapsedMs: Date.now() - started,
    };
  }
}

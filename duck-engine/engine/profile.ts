/**
 * Column profiling: fill rate, cardinality, range and the values that dominate
 * a column. Two bounded queries per column, both of which DuckDB answers by
 * streaming the Parquet column chunk — nothing here loads the whole file.
 */

import type { ColumnProfile } from '../shared/protocol.js';
import { EngineDb } from './db.js';
import { quoteIdent, quoteLit, textExpr } from './sql.js';
import type { ResolvedView } from './view.js';

const HISTOGRAM_BUCKETS = 12;

export class Profiler {
  constructor(private readonly db: EngineDb) {}

  async column(
    relation: string,
    resolved: ResolvedView,
    columnName: string,
    topN: number,
  ): Promise<ColumnProfile> {
    const started = Date.now();
    const col = resolved.columns.find((c) => c.name === columnName);
    if (!col) {
      throw Object.assign(new Error(`No column named ${columnName}`), { code: 'invalid-request' });
    }
    const id = quoteIdent(col.name);
    const txt = textExpr(col);

    const aggregates: string[] = [
      `count(*)::BIGINT AS "rows"`,
      `count(${id})::BIGINT AS "non_null"`,
      `sum(CASE WHEN ${id} IS NULL THEN 1 ELSE 0 END)::BIGINT AS "null_count"`,
      `sum(CASE WHEN ${txt} = '' THEN 1 ELSE 0 END)::BIGINT AS "empty_count"`,
      `approx_count_distinct(${txt})::BIGINT AS "distinct_approx"`,
      `avg(length(${txt}))::DOUBLE AS "avg_len"`,
    ];

    if (col.numeric) {
      aggregates.push(
        `min(${id})::VARCHAR AS "min_v"`,
        `max(${id})::VARCHAR AS "max_v"`,
        `avg(${id}::DOUBLE)::VARCHAR AS "avg_v"`,
        `stddev_pop(${id}::DOUBLE)::VARCHAR AS "sd_v"`,
      );
    } else if (col.temporal) {
      aggregates.push(
        `min(${id})::VARCHAR AS "min_v"`,
        `max(${id})::VARCHAR AS "max_v"`,
        `NULL AS "avg_v"`,
        `NULL AS "sd_v"`,
      );
    } else {
      aggregates.push(
        `min(${txt}) AS "min_v"`,
        `max(${txt}) AS "max_v"`,
        `NULL AS "avg_v"`,
        `NULL AS "sd_v"`,
      );
    }

    const row = await this.db.queryOneRow(
      `SELECT ${aggregates.join(', ')} FROM ${relation}`,
      `profiling ${col.name}`,
    );
    const num = (v: string | null | undefined): number => (v == null ? 0 : Number(v));

    const top = await this.db.queryRows(
      `SELECT ${txt} AS v, count(*)::BIGINT AS c
       FROM ${relation}
       GROUP BY 1
       ORDER BY c DESC, v
       LIMIT ${Math.max(1, Math.min(topN, 200))}`,
      `profiling ${col.name}`,
    );

    let histogram: ColumnProfile['histogram'] = null;
    if (col.numeric && row) {
      const min = Number(row[6]);
      const max = Number(row[7]);
      if (Number.isFinite(min) && Number.isFinite(max) && max > min) {
        const width = (max - min) / HISTOGRAM_BUCKETS;
        const bucketExpr = `least(${HISTOGRAM_BUCKETS - 1}, floor((${id}::DOUBLE - ${min}) / ${width})::INTEGER)`;
        const hist = await this.db.queryRows(
          `SELECT ${bucketExpr} AS b, count(*)::BIGINT AS c
           FROM ${relation} WHERE ${id} IS NOT NULL
           GROUP BY 1 ORDER BY 1`,
          `profiling ${col.name}`,
        );
        histogram = hist.map((r) => {
          const b = Number(r[0] ?? 0);
          const lo = min + b * width;
          const hi = b === HISTOGRAM_BUCKETS - 1 ? max : lo + width;
          return { bucket: `${formatNum(lo)} – ${formatNum(hi)}`, count: Number(r[1] ?? 0) };
        });
      }
    }

    return {
      column: col.name,
      type: col.type,
      rows: num(row?.[0]),
      nonNull: num(row?.[1]),
      nulls: num(row?.[2]),
      empty: num(row?.[3]),
      distinctApprox: num(row?.[4]),
      avgLength: row?.[5] ?? null,
      min: row?.[6] ?? null,
      max: row?.[7] ?? null,
      avg: row?.[8] ?? null,
      stddev: row?.[9] ?? null,
      topValues: top.map((r) => ({ value: r[0] ?? null, count: Number(r[1] ?? 0) })),
      histogram,
      elapsedMs: Date.now() - started,
    };
  }

  /**
   * Coverage across every column in one pass: fill rate and approximate
   * cardinality only, so the cost stays linear in columns rather than queries.
   */
  async all(relation: string, resolved: ResolvedView): Promise<ColumnProfile[]> {
    const started = Date.now();
    const parts: string[] = [`count(*)::BIGINT AS "__rows"`];
    for (const [i, col] of resolved.columns.entries()) {
      const id = quoteIdent(col.name);
      const txt = textExpr(col);
      parts.push(
        `count(${id})::BIGINT AS ${quoteIdent(`nn_${i}`)}`,
        `sum(CASE WHEN ${txt} = '' THEN 1 ELSE 0 END)::BIGINT AS ${quoteIdent(`em_${i}`)}`,
        `approx_count_distinct(${txt})::BIGINT AS ${quoteIdent(`dc_${i}`)}`,
      );
    }
    const row = await this.db.queryOneRow(
      `SELECT ${parts.join(', ')} FROM ${relation}`,
      'profiling every column',
    );
    const rows = Number(row?.[0] ?? 0);
    return resolved.columns.map((col, i) => {
      const nn = Number(row?.[1 + i * 3] ?? 0);
      const em = Number(row?.[2 + i * 3] ?? 0);
      const dc = Number(row?.[3 + i * 3] ?? 0);
      return {
        column: col.name,
        type: col.type,
        rows,
        nonNull: nn,
        nulls: rows - nn,
        empty: em,
        distinctApprox: dc,
        min: null,
        max: null,
        avg: null,
        stddev: null,
        avgLength: null,
        topValues: [],
        histogram: null,
        elapsedMs: Date.now() - started,
      };
    });
  }

  /** Distinct values of a column, for the filter builder's value picker. */
  async distinctValues(
    relation: string,
    columnExprSource: { name: string; nested: boolean; type: string; numeric: boolean; temporal: boolean },
    limit: number,
    contains: string | null,
  ): Promise<{ value: string | null; count: number }[]> {
    const txt = textExpr(columnExprSource);
    const where = contains ? `WHERE ${txt} ILIKE ${quoteLit('%' + contains.replace(/([%_\\])/g, '\\$1') + '%')} ESCAPE '\\'` : '';
    const rows = await this.db.queryRows(
      `SELECT ${txt} AS v, count(*)::BIGINT AS c FROM ${relation} ${where}
       GROUP BY 1 ORDER BY c DESC, v LIMIT ${Math.max(1, Math.min(limit, 1000))}`,
      'listing values',
    );
    return rows.map((r) => ({ value: r[0] ?? null, count: Number(r[1] ?? 0) }));
  }
}

function formatNum(v: number): string {
  if (Number.isInteger(v)) return String(v);
  const abs = Math.abs(v);
  if (abs >= 1000) return v.toFixed(0);
  if (abs >= 1) return v.toFixed(2);
  return v.toPrecision(3);
}

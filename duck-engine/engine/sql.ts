/**
 * SQL construction. Every identifier and literal that reaches DuckDB goes
 * through here, so a column called `select` or a value containing a quote
 * cannot break a query or smuggle SQL in.
 */

import { createHash } from 'node:crypto';
import type {
  ColumnInfo,
  FilterSpec,
  SearchSpec,
  SortSpec,
  ViewSpec,
} from '../shared/protocol.js';

/** Column name DuckDB reserves when we ask for row numbers. */
export const PARQUET_ROWNUM = 'file_row_number';
/** Our own carried-through source row number. */
export const SOURCE_ROWNUM = '__giga_rn';
/** Names a user column may not have; ingest renames collisions. */
export const RESERVED_COLUMNS = new Set([PARQUET_ROWNUM, SOURCE_ROWNUM]);

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function quoteLit(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Windows paths contain backslashes; DuckDB string literals treat them literally, so only quotes need escaping. */
export function quotePath(p: string): string {
  return quoteLit(p);
}

const NUMERIC_RE =
  /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|FLOAT|DOUBLE|DECIMAL|REAL|NUMERIC)/i;
const TEMPORAL_RE = /^(DATE|TIME|TIMESTAMP|INTERVAL)/i;
const NESTED_RE = /^(STRUCT|MAP|LIST|UNION|JSON|ARRAY)/i;

export function isNumericType(type: string): boolean {
  return NUMERIC_RE.test(type.trim());
}
export function isTemporalType(type: string): boolean {
  return TEMPORAL_RE.test(type.trim());
}
export function isNestedType(type: string): boolean {
  const t = type.trim();
  return NESTED_RE.test(t) || t.endsWith('[]');
}

export function describeColumn(name: string, type: string, originalName?: string): ColumnInfo {
  const info: ColumnInfo = {
    name,
    type,
    nested: isNestedType(type),
    numeric: isNumericType(type),
    temporal: isTemporalType(type),
  };
  if (originalName && originalName !== name) info.originalName = originalName;
  return info;
}

/** A scalar text form of a column, safe for display, comparison and search. */
export function textExpr(col: ColumnInfo): string {
  const id = quoteIdent(col.name);
  if (col.nested) return `to_json(${id})::VARCHAR`;
  return `CAST(${id} AS VARCHAR)`;
}

/** Display expression: text form, truncated so one enormous cell cannot flood IPC. */
export function displayExpr(col: ColumnInfo, maxChars: number): string {
  const base = textExpr(col);
  // substr on a NULL stays NULL, which is what we want.
  return `CASE WHEN length(${base}) > ${maxChars}
    THEN substr(${base}, 1, ${maxChars}) || '…'
    ELSE ${base} END AS ${quoteIdent(col.name)}`;
}

function likeOperator(caseSensitive: boolean): string {
  return caseSensitive ? 'LIKE' : 'ILIKE';
}

function escapeLikePattern(v: string): string {
  return v.replace(/([%_\\])/g, '\\$1');
}

/** Compile one filter into a boolean SQL expression, or null when it is a no-op. */
export function filterExpr(f: FilterSpec, col: ColumnInfo | undefined): string | null {
  if (!f.enabled || !col) return null;
  const id = quoteIdent(col.name);
  const txt = textExpr(col);
  const op = likeOperator(f.caseSensitive);

  switch (f.op) {
    case 'isnull':
      return `${id} IS NULL`;
    case 'notnull':
      return `${id} IS NOT NULL`;
    default:
      break;
  }

  if (f.value === '' && f.op !== 'eq' && f.op !== 'ne') return null;

  switch (f.op) {
    case 'eq':
    case 'ne': {
      const neg = f.op === 'ne';
      if (col.numeric || col.temporal) {
        const cast = tryCastLiteral(col, f.value);
        if (cast) return neg ? `(${id} IS DISTINCT FROM ${cast})` : `${id} = ${cast}`;
      }
      const cmp = f.caseSensitive
        ? `${txt} = ${quoteLit(f.value)}`
        : `lower(${txt}) = lower(${quoteLit(f.value)})`;
      return neg ? `NOT (${cmp}) OR ${id} IS NULL` : cmp;
    }
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte': {
      const sym = { lt: '<', lte: '<=', gt: '>', gte: '>=' }[f.op];
      const cast = tryCastLiteral(col, f.value);
      return `${cast ? id : txt} ${sym} ${cast ?? quoteLit(f.value)}`;
    }
    case 'between': {
      const a = tryCastLiteral(col, f.value);
      const b = tryCastLiteral(col, f.value2);
      if (a && b) return `${id} BETWEEN ${a} AND ${b}`;
      return `${txt} BETWEEN ${quoteLit(f.value)} AND ${quoteLit(f.value2)}`;
    }
    case 'contains':
      return `${txt} ${op} ${quoteLit('%' + escapeLikePattern(f.value) + '%')} ESCAPE '\\'`;
    case 'ncontains':
      return `(${txt} IS NULL OR NOT (${txt} ${op} ${quoteLit(
        '%' + escapeLikePattern(f.value) + '%',
      )} ESCAPE '\\'))`;
    case 'startswith':
      return `${txt} ${op} ${quoteLit(escapeLikePattern(f.value) + '%')} ESCAPE '\\'`;
    case 'endswith':
      return `${txt} ${op} ${quoteLit('%' + escapeLikePattern(f.value))} ESCAPE '\\'`;
    case 'in': {
      const parts = f.value
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (parts.length === 0) return null;
      const list = parts.map((p) => quoteLit(f.caseSensitive ? p : p.toLowerCase())).join(', ');
      return f.caseSensitive ? `${txt} IN (${list})` : `lower(${txt}) IN (${list})`;
    }
    case 'regex': {
      const flags = f.caseSensitive ? '' : `, 'i'`;
      return `regexp_matches(${txt}, ${quoteLit(f.value)}${flags})`;
    }
    default:
      return null;
  }
}

/**
 * Numeric and temporal comparisons are much faster (and prune Parquet row
 * groups) when done in the column's own type, so we cast the literal when it
 * plausibly parses and fall back to text comparison when it does not.
 */
function tryCastLiteral(col: ColumnInfo, raw: string): string | null {
  const v = raw.trim();
  if (v === '') return null;
  if (col.numeric) {
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(v)) return null;
    return `CAST(${quoteLit(v)} AS ${col.type})`;
  }
  if (col.temporal) {
    if (!/^[\d\s:.+\-TZ/]+$/i.test(v)) return null;
    return `TRY_CAST(${quoteLit(v)} AS ${col.type})`;
  }
  return null;
}

export function searchExpr(search: SearchSpec, columns: ColumnInfo[]): string | null {
  const q = search.query;
  if (!q) return null;
  const targets = search.columns
    ? columns.filter((c) => search.columns!.includes(c.name))
    : columns.filter((c) => search.includeNested || !c.nested);
  if (targets.length === 0) return null;

  const parts = targets.map((c) => {
    const txt = textExpr(c);
    switch (search.mode) {
      case 'exact':
        return search.caseSensitive
          ? `${txt} = ${quoteLit(q)}`
          : `lower(${txt}) = lower(${quoteLit(q)})`;
      case 'regex': {
        const flags = search.caseSensitive ? '' : `, 'i'`;
        return `regexp_matches(${txt}, ${quoteLit(q)}${flags})`;
      }
      case 'contains':
      default:
        return `${txt} ${likeOperator(search.caseSensitive)} ${quoteLit(
          '%' + escapeLikePattern(q) + '%',
        )} ESCAPE '\\'`;
    }
  });
  return `(${parts.join(' OR ')})`;
}

export function whereClause(view: ViewSpec, columns: ColumnInfo[]): string {
  const byName = new Map(columns.map((c) => [c.name, c]));
  const filterParts = view.filters
    .map((f) => filterExpr(f, byName.get(f.column)))
    .filter((s): s is string => s !== null);
  const clauses: string[] = [];
  if (filterParts.length > 0) {
    const joiner = view.combine === 'or' ? ' OR ' : ' AND ';
    clauses.push(`(${filterParts.map((p) => `(${p})`).join(joiner)})`);
  }
  if (view.search?.asFilter) {
    const s = searchExpr(view.search, columns);
    if (s) clauses.push(s);
  }
  return clauses.length ? clauses.join(' AND ') : '';
}

export function orderByClause(sort: SortSpec[], columns: ColumnInfo[]): string {
  const byName = new Map(columns.map((c) => [c.name, c]));
  const parts = sort
    .map((s) => {
      const col = byName.get(s.column);
      if (!col) return null;
      const target = col.nested ? textExpr(col) : quoteIdent(col.name);
      const dir = s.dir === 'desc' ? 'DESC' : 'ASC';
      const nulls = s.nullsFirst ? 'NULLS FIRST' : 'NULLS LAST';
      return `${target} ${dir} ${nulls}`;
    })
    .filter((s): s is string => s !== null);
  return parts.length ? parts.join(', ') : '';
}

export function selectedColumns(view: ViewSpec, columns: ColumnInfo[]): ColumnInfo[] {
  if (!view.select || view.select.length === 0) return columns;
  const wanted = new Set(view.select);
  const picked = columns.filter((c) => wanted.has(c.name));
  return picked.length > 0 ? picked : columns;
}

/** True when the view neither filters, searches nor sorts. */
export function isIdentityView(view: ViewSpec): boolean {
  const activeFilters = view.filters.filter((f) => f.enabled);
  const searchFilters = !!(view.search?.asFilter && view.search.query);
  return activeFilters.length === 0 && !searchFilters && view.sort.length === 0;
}

/** Stable key for a (dataset, view) pair — used to name and reuse derived Parquet files. */
export function viewKey(datasetId: string, view: ViewSpec, columns: ColumnInfo[]): string {
  const normalised = {
    filters: view.filters
      .filter((f) => f.enabled)
      .map((f) => [f.column, f.op, f.value, f.value2, f.caseSensitive])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    combine: view.combine,
    search:
      view.search?.query && view.search.asFilter
        ? [
            view.search.query,
            view.search.mode,
            view.search.caseSensitive,
            view.search.includeNested,
            (view.search.columns ?? []).slice().sort(),
          ]
        : null,
    sort: view.sort.map((s) => [s.column, s.dir, !!s.nullsFirst]),
    select: view.select ? view.select.slice().sort() : null,
    cols: columns.map((c) => c.name + ':' + c.type),
  };
  return createHash('sha1')
    .update(datasetId)
    .update(JSON.stringify(normalised))
    .digest('hex')
    .slice(0, 20);
}

/** Reject anything that is not a single read-only statement. */
export function assertReadOnlySql(sql: string): void {
  const stripped = sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .trim();
  if (!stripped) throw new Error('Empty statement.');
  const forbidden =
    /\b(ATTACH|DETACH|INSTALL|LOAD|COPY|EXPORT|IMPORT|CREATE|DROP|ALTER|INSERT|UPDATE|DELETE|TRUNCATE|CALL|PRAGMA|SET|RESET|CHECKPOINT|VACUUM|INSTALL)\b/i;
  const m = forbidden.exec(stripped);
  if (m) {
    throw new Error(
      `Only read-only queries are allowed in the SQL console. Remove "${m[1]!.toUpperCase()}".`,
    );
  }
}

export function limitWrap(sql: string, limit: number): string {
  return `SELECT * FROM (${sql.replace(/;\s*$/, '')}) AS q LIMIT ${Math.max(1, Math.floor(limit))}`;
}

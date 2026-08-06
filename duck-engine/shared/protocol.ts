/**
 * The single source of truth for every message that crosses a process boundary:
 * renderer -> main -> engine (utility process) and back.
 *
 * Keeping this in one file means the renderer, the main process and the engine
 * cannot drift apart: a change here is a compile error everywhere it matters.
 */

export const PROTOCOL_VERSION = 1;

/* ------------------------------------------------------------------ formats */

export type SourceFormat = 'csv' | 'tsv' | 'psv' | 'delimited' | 'parquet' | 'unsupported' | 'unknown';

export type Compression = 'none' | 'gzip' | 'zstd';

export const FORMAT_LABEL: Record<SourceFormat, string> = {
  csv: 'CSV',
  tsv: 'TSV',
  psv: 'Pipe-delimited',
  delimited: 'Delimited text',
  parquet: 'Parquet',
  unsupported: 'Unsupported format',
  unknown: 'Unknown',
};

/** Extensions the open dialog and file associations offer. */
export const SUPPORTED_EXTENSIONS = ['csv', 'tsv', 'psv', 'txt', 'tab', 'dat', 'parquet'] as const;

/** Everything sniffing could work out about a file before we commit to reading it. */
export interface DetectResult {
  path: string;
  name: string;
  sizeBytes: number;
  mtimeMs: number;
  format: SourceFormat;
  compression: Compression;
  encoding: string;
  delimiter: string | null;
  quote: string | null;
  escape: string | null;
  hasHeader: boolean | null;
  /** Preamble lines above the first real row (an export banner, a title). */
  skipRows: number;
  /** Every delimiter that plausibly splits the sample, best first. */
  delimiterCandidates: string[];
  /** '"' when the file looks properly quoted; null when quoting should be off. */
  suggestQuote: string | null;
  /** 0..1 — how much we trust the guess. Below 0.6 the UI asks the user. */
  confidence: number;
  /** First few KB, decoded, for the preview pane. */
  sampleText: string;
  warnings: string[];
  /** True when a cache entry for this exact file (path+size+mtime) already exists. */
  cached: boolean;
}

/* ------------------------------------------------------------------- ingest */

export interface OpenOptions {
  format?: SourceFormat;
  delimiter?: string | null;
  /**
   * True when a person chose the delimiter. Auto-detection is only a hint and
   * may be overruled by DuckDB's own sniffer; an explicit choice may not be.
   */
  delimiterExplicit?: boolean;
  /** Lines to skip before the header. */
  skipRows?: number;
  quote?: string | null;
  escape?: string | null;
  hasHeader?: boolean | null;
  /**
   * True when a person chose whether the first row is a header. Detection is
   * only a hint and may be overruled by DuckDB's sniffer; an explicit choice
   * may not be.
   */
  hasHeaderExplicit?: boolean;
  encoding?: string;
  /** Read every column as text. Slower to analyse, but never fails on type conflicts. */
  allVarchar?: boolean;
  /** Skip rows the parser rejects instead of aborting the load. */
  ignoreErrors?: boolean;
  /** Pad short CSV rows with NULLs rather than erroring. */
  nullPadding?: boolean;
  /** Rows sampled for type inference. -1 scans the whole file (slow, most accurate). */
  sampleSize?: number;
  /** Expand top-level STRUCT columns into their own columns (Parquet only). */
  flatten?: boolean;
  /** Trade input row order for ingest speed and lower memory. */
  unorderedFast?: boolean;
  /** Ignore any cached Parquet and read the source again. */
  forceReingest?: boolean;
  /** Explicit column types, name -> DuckDB type. Overrides inference. */
  columnTypes?: Record<string, string> | null;
}

export interface ColumnInfo {
  name: string;
  /** DuckDB type string, e.g. VARCHAR, BIGINT, STRUCT(a INTEGER). */
  type: string;
  nested: boolean;
  numeric: boolean;
  temporal: boolean;
  /** Set when the source name collided with a reserved internal name. */
  originalName?: string;
}

export type IngestStrategy =
  | 'cache-hit'
  | 'parquet-passthrough'
  | 'csv-auto'
  | 'csv-lenient'
  | 'csv-all-varchar'
  | 'raw-lines';

export interface DatasetManifest {
  version: number;
  id: string;
  sourcePath: string;
  sourceName: string;
  sourceSize: number;
  sourceMtimeMs: number;
  format: SourceFormat;
  compression: Compression;
  options: OpenOptions;
  parquetPath: string;
  parquetBytes: number;
  rowCount: number;
  columns: ColumnInfo[];
  ingestedAtMs: number;
  ingestMs: number;
  strategy: IngestStrategy;
  /** Chain of attempts that failed before the successful one. */
  attempts: { strategy: IngestStrategy; error: string }[];
  warnings: string[];
  /** Source column name -> safe name, when a rename was forced. */
  renamedColumns: Record<string, string>;
}

/* -------------------------------------------------------------------- views */

export type SortDir = 'asc' | 'desc';

export interface SortSpec {
  column: string;
  dir: SortDir;
  nullsFirst?: boolean;
}

export type FilterOp =
  | 'eq'
  | 'ne'
  | 'lt'
  | 'lte'
  | 'gt'
  | 'gte'
  | 'contains'
  | 'ncontains'
  | 'startswith'
  | 'endswith'
  | 'isnull'
  | 'notnull'
  | 'in'
  | 'regex'
  | 'between';

export const FILTER_OP_LABEL: Record<FilterOp, string> = {
  eq: '=',
  ne: '≠',
  lt: '<',
  lte: '≤',
  gt: '>',
  gte: '≥',
  contains: 'contains',
  ncontains: 'does not contain',
  startswith: 'starts with',
  endswith: 'ends with',
  isnull: 'is null',
  notnull: 'is not null',
  in: 'in list',
  regex: 'matches regex',
  between: 'between',
};

/** Ops that need no operand. */
export const NULLARY_OPS: FilterOp[] = ['isnull', 'notnull'];

export interface FilterSpec {
  id: string;
  column: string;
  op: FilterOp;
  value: string;
  value2: string;
  caseSensitive: boolean;
  enabled: boolean;
}

export type SearchMode = 'contains' | 'exact' | 'regex';

export interface SearchSpec {
  query: string;
  mode: SearchMode;
  /** null = every column. */
  columns: string[] | null;
  caseSensitive: boolean;
  /** Search inside nested (JSON) columns too. */
  includeNested: boolean;
  /**
   * true  — the view contains only matching rows.
   * false — the view keeps every row and the UI steps between matches.
   */
  asFilter: boolean;
}

export interface ViewSpec {
  filters: FilterSpec[];
  combine: 'and' | 'or';
  search: SearchSpec | null;
  sort: SortSpec[];
  /** Projection. null = every column. */
  select: string[] | null;
}

export const EMPTY_VIEW: ViewSpec = {
  filters: [],
  combine: 'and',
  search: null,
  sort: [],
  select: null,
};

export interface ViewInfo {
  key: string;
  datasetId: string;
  rowCount: number;
  /** True when a derived Parquet was written so paging is O(page). */
  materialized: boolean;
  columns: ColumnInfo[];
  buildMs: number;
  /** True when the view is just the base dataset. */
  identity: boolean;
}

/* ------------------------------------------------------------------- paging */

export interface PageRequest {
  datasetId: string;
  view: ViewSpec;
  offset: number;
  limit: number;
  maxCellChars?: number;
}

export interface PageResult {
  viewKey: string;
  offset: number;
  columns: ColumnInfo[];
  /** Cell text, already truncated to maxCellChars. null means SQL NULL. */
  rows: (string | null)[][];
  /** Row number in the original file for each row, -1 when unknown. */
  sourceRows: number[];
  totalRows: number;
  /** True when at least one cell in the page hit maxCellChars. */
  truncated: boolean;
  elapsedMs: number;
}

/* ------------------------------------------------------------------ profile */

export interface ColumnProfile {
  column: string;
  type: string;
  rows: number;
  nonNull: number;
  nulls: number;
  empty: number;
  distinctApprox: number;
  min: string | null;
  max: string | null;
  avg: string | null;
  stddev: string | null;
  /** Mean length for text columns. */
  avgLength: string | null;
  topValues: { value: string | null; count: number }[];
  histogram: { bucket: string; count: number }[] | null;
  elapsedMs: number;
}

/* -------------------------------------------------------------------- tools */

export interface SqlResult {
  columns: { name: string; type: string }[];
  rows: (string | null)[][];
  rowCount: number;
  truncatedAt: number | null;
  elapsedMs: number;
  /** Statement text as executed, after view substitution. */
  executed: string;
}

export type ExportFormat = 'csv' | 'tsv' | 'psv' | 'parquet' | 'xlsx-csv';

export interface ExportRequest {
  datasetId: string;
  view: ViewSpec;
  targetPath: string;
  format: ExportFormat;
  /** null = all rows in the view. */
  limit: number | null;
  /** For row-subset exports driven by the grid selection. */
  sourceRows?: number[] | null;
  prettyJson?: boolean;
  includeHeader?: boolean;
  delimiter?: string;
  compression?: 'none' | 'gzip' | 'zstd';
}

export interface ExportResult {
  targetPath: string;
  rowsWritten: number;
  bytesWritten: number;
  elapsedMs: number;
}

export interface DiffRequest {
  leftId: string;
  rightId: string;
  /** Columns that identify a row. Empty = compare positionally by row number. */
  keyColumns: string[];
  /** Columns to compare. null = intersection of both schemas. */
  compareColumns: string[] | null;
  maxExamples: number;
}

export interface DiffResult {
  leftRows: number;
  rightRows: number;
  onlyLeft: number;
  onlyRight: number;
  changed: number;
  identical: number;
  columnsOnlyLeft: string[];
  columnsOnlyRight: string[];
  columnStats: { column: string; changed: number }[];
  examples: {
    kind: 'only-left' | 'only-right' | 'changed';
    key: string;
    left: Record<string, string | null> | null;
    right: Record<string, string | null> | null;
    changedColumns: string[];
  }[];
  elapsedMs: number;
}

export interface ConvertRequest {
  datasetId: string;
  view: ViewSpec;
  targetPath: string;
  format: ExportFormat;
}

/* ------------------------------------------------------------------ preview */

/**
 * A few rows parsed with a candidate set of options, so the Open dialog can show
 * what the file will actually look like before anything is loaded.
 */
export interface PreviewResult {
  columns: { name: string; type: string }[];
  rows: (string | null)[][];
  /** What the engine settled on, which may differ from what was requested. */
  usedDelimiter: string | null;
  usedFormat: SourceFormat;
  usedSkipRows: number;
  strategy: IngestStrategy;
  warnings: string[];
  error: string | null;
}

/* ---------------------------------------------------------------- raw bytes */

export interface RawSlice {
  path: string;
  offset: number;
  length: number;
  totalBytes: number;
  text: string;
  /** Byte offset of the first complete line in `text`. */
  lineStartOffset: number;
  atEnd: boolean;
}

/* --------------------------------------------------------------- cache mgmt */

export interface CacheEntrySummary {
  id: string;
  sourceName: string;
  sourcePath: string;
  sourceSize: number;
  parquetBytes: number;
  derivedBytes: number;
  rowCount: number;
  ingestedAtMs: number;
  lastUsedMs: number;
  sourceMissing: boolean;
  stale: boolean;
}

export interface CacheInfo {
  dir: string;
  totalBytes: number;
  limitBytes: number;
  entries: CacheEntrySummary[];
}

/* ---------------------------------------------------------------- jobs/events */

export type JobKind =
  | 'ingest'
  | 'materialize'
  | 'count'
  | 'profile'
  | 'export'
  | 'convert'
  | 'diff'
  | 'sql';

export interface JobProgress {
  jobId: string;
  kind: JobKind;
  label: string;
  phase: string;
  /** 0..100, or null when the engine cannot estimate. */
  percent: number | null;
  indeterminate: boolean;
  bytesDone: number | null;
  bytesTotal: number | null;
  rowsDone: number | null;
  elapsedMs: number;
  etaMs: number | null;
  cancellable: boolean;
}

export interface EngineStats {
  duckdbVersion: string;
  threads: number;
  memoryLimit: string;
  tempDir: string;
  totalSystemMemory: number;
  engineRss: number;
  openDatasets: number;
  cacheBytes: number;
  uptimeMs: number;
  restarts: number;
}

export type EngineEvent =
  | { type: 'job'; progress: JobProgress }
  | { type: 'job-end'; jobId: string; ok: boolean; error?: string; cancelled?: boolean }
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string; at: number }
  | { type: 'engine-state'; state: 'starting' | 'ready' | 'crashed' | 'restarting'; detail?: string }
  | { type: 'dataset-closed'; datasetId: string; reason: string };

/* ------------------------------------------------------------------- errors */

export type EngineErrorCode =
  | 'not-found'
  | 'unsupported'
  | 'parse-failed'
  | 'cancelled'
  | 'out-of-memory'
  | 'disk-full'
  | 'invalid-request'
  | 'engine-down'
  | 'internal';

export interface EngineErrorShape {
  code: EngineErrorCode;
  message: string;
  /** Operator-facing hint: what to change to make this work. */
  hint?: string;
  detail?: string;
}

/* ------------------------------------------------------------------ methods */

export interface EngineApi {
  ping(): { ok: true; version: number };
  stats(): EngineStats;

  detect(params: { path: string }): DetectResult;
  previewRows(params: { path: string; options: OpenOptions; limit: number }): PreviewResult;
  openDataset(params: { path: string; options: OpenOptions; jobId: string }): DatasetManifest;
  closeDataset(params: { datasetId: string }): { ok: true };
  listDatasets(): DatasetManifest[];

  buildView(params: { datasetId: string; view: ViewSpec; jobId: string }): ViewInfo;
  getPage(params: PageRequest): PageResult;
  getRowJson(params: { datasetId: string; view: ViewSpec; viewRow: number }): { json: string; sourceRow: number };
  findNextMatch(params: {
    datasetId: string;
    view: ViewSpec;
    fromViewRow: number;
    direction: 'next' | 'prev';
  }): { viewRow: number | null };

  profileColumn(params: {
    datasetId: string;
    view: ViewSpec;
    column: string;
    topN: number;
    jobId: string;
  }): ColumnProfile;
  profileAll(params: { datasetId: string; view: ViewSpec; jobId: string }): ColumnProfile[];

  runSql(params: { datasetId: string | null; sql: string; limit: number; jobId: string }): SqlResult;
  exportView(params: ExportRequest & { jobId: string }): ExportResult;
  diffDatasets(params: DiffRequest & { jobId: string }): DiffResult;

  rawSlice(params: { path: string; offset: number; length: number }): RawSlice;

  cacheInfo(): CacheInfo;
  clearCache(): { removed: number; bytes: number };
  removeCacheEntry(params: { id: string }): { ok: true };
  setCacheLimit(params: { bytes: number }): { ok: true };

  cancel(params: { jobId: string }): { ok: true };
}

export type EngineMethod = keyof EngineApi;
export type EngineParams<M extends EngineMethod> = Parameters<EngineApi[M]>[0];
export type EngineReturn<M extends EngineMethod> = ReturnType<EngineApi[M]>;

/* --------------------------------------------------------- app-level (main) */

export interface AppSettings {
  theme: 'system' | 'light' | 'dark';
  pageSize: number;
  maxCellChars: number;
  /** Row count above which a view gets materialised instead of queried live. */
  materializeThreshold: number;
  cacheLimitBytes: number;
  memoryLimitMode: 'auto' | 'fixed';
  memoryLimitMb: number;
  threads: number | null;
  defaultSampleSize: number;
  confirmLargeIngest: boolean;
  largeIngestWarnBytes: number;
  gridDensity: 'compact' | 'normal';
  monospaceGrid: boolean;
  showRowNumbers: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  pageSize: 200,
  maxCellChars: 2000,
  materializeThreshold: 500_000,
  cacheLimitBytes: 64 * 1024 * 1024 * 1024,
  memoryLimitMode: 'auto',
  memoryLimitMb: 4096,
  threads: null,
  defaultSampleSize: 200_000,
  confirmLargeIngest: true,
  largeIngestWarnBytes: 2 * 1024 * 1024 * 1024,
  gridDensity: 'normal',
  monospaceGrid: true,
  showRowNumbers: true,
};

export interface RecentFile {
  path: string;
  name: string;
  sizeBytes: number;
  lastOpenedMs: number;
  format: SourceFormat;
  rowCount: number | null;
  options: OpenOptions;
}

export interface AppApi {
  getSettings(): AppSettings;
  setSettings(params: Partial<AppSettings>): AppSettings;
  getRecents(): RecentFile[];
  removeRecent(params: { path: string }): RecentFile[];
  clearRecents(): RecentFile[];
  pickOpenPath(params: { multi?: boolean }): string[];
  pickSavePath(params: { defaultName: string; filters?: { name: string; extensions: string[] }[] }): string | null;
  showItemInFolder(params: { path: string }): { ok: true };
  openExternal(params: { url: string }): { ok: true };
  platformInfo(): {
    platform: string;
    arch: string;
    electron: string;
    node: string;
    chrome: string;
    appVersion: string;
    totalMemory: number;
    cpus: number;
  };
  restartEngine(): { ok: true };
}

export type AppMethod = keyof AppApi;
export type AppParams<M extends AppMethod> = Parameters<AppApi[M]>[0];
export type AppReturn<M extends AppMethod> = ReturnType<AppApi[M]>;

/* --------------------------------------------------------------- wire types */

export interface RpcRequest {
  id: number;
  method: string;
  params?: unknown;
}

export type RpcResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: EngineErrorShape };

export type RpcMessage = RpcResponse | { event: EngineEvent };

export const IPC = {
  engineInvoke: 'giga:engine-invoke',
  appInvoke: 'giga:app-invoke',
  event: 'giga:event',
  menuCommand: 'giga:menu-command',
} as const;

export type MenuCommand =
  | 'open-file'
  | 'open-url'
  | 'close-tab'
  | 'reload-tab'
  | 'duplicate-tab'
  | 'next-tab'
  | 'prev-tab'
  | 'find'
  | 'find-next'
  | 'find-prev'
  | 'go-to-row'
  | 'toggle-tree'
  | 'toggle-sidebar'
  | 'toggle-sql'
  | 'toggle-profile'
  | 'export'
  | 'convert'
  | 'diff'
  | 'settings'
  | 'cache-manager'
  | 'copy-cell'
  | 'copy-row'
  | 'copy-path'
  | 'theme-light'
  | 'theme-dark'
  | 'theme-system'
  | 'about';

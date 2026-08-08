/**
 * Ingest: turn a source file into one Parquet file in the cache.
 *
 * Real files are messy, so instead of one clever reader call we walk a ladder of
 * progressively more forgiving strategies and record which one worked. The user
 * always ends up with *something* they can look at — worst case, one column of
 * raw lines — and the manifest says exactly what was compromised to get there.
 */

import { createReadStream, createWriteStream } from 'node:fs';
import { rename, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { createGunzip } from 'node:zlib';
import type {
  ColumnInfo,
  DatasetManifest,
  IngestStrategy,
  OpenOptions,
  PreviewResult,
  SourceFormat,
} from '../shared/protocol.js';
import { DatasetCache, MANIFEST_VERSION, fileSize } from './cache.js';
import { EngineDb, EngineError, mapDuckError } from './db.js';
import { detectFile } from './detect.js';
import {
  RESERVED_COLUMNS,
  describeColumn,
  isNestedType,
  quoteIdent,
  quotePath,
  quoteLit,
} from './sql.js';

export interface IngestProgress {
  phase: string;
  percent: number | null;
  rowsDone: number | null;
  bytesDone: number | null;
  bytesTotal: number | null;
}

export type ProgressSink = (p: IngestProgress) => void;

const ROW_GROUP_SIZE = 122_880;

interface ReaderPlan {
  strategy: IngestStrategy;
  /** Table function expression, e.g. read_csv('/x.csv', ...). */
  reader: string;
  notes: string[];
  /**
   * Reject this plan if it yields fewer columns than this.
   *
   * This is the load-bearing part of reading delimited files. `read_csv` with the
   * wrong delimiter does not fail — it happily returns one column containing
   * whole lines. Without a minimum, the first plan always "succeeds" and the user
   * gets a single-column table. Requiring two columns while alternatives remain
   * turns that silent wrong answer into a retry.
   */
  minColumns: number;
  /** Delimiter this plan reads with, for the manifest and the UI. */
  delimiter?: string | null;
  /** Quote character in effect; null means quoting is off. */
  quoteChar?: string | null;
  /** Header mode this plan asked for; undefined means DuckDB decided. */
  header?: boolean;
  skipRows?: number;
  /** Cheaper reader used for the column-count probe. Defaults to `reader`. */
  probeReader?: string;
}

interface CsvVariant {
  lenient?: boolean;
  allVarchar?: boolean;
  delimiter?: string | null;
  skipRows?: number;
  /**
   * undefined — use whatever the options say.
   * null      — quoting off: a bare " is ordinary text.
   * string    — use this quote character.
   */
  quoteChar?: string | null;
  encoding?: string;
  sampleSize?: number;
  /** undefined leaves the decision to DuckDB's sniffer. */
  header?: boolean;
}

function csvArgs(o: OpenOptions, opts: CsvVariant): string[] {
  const args: string[] = [];
  const delimiter = opts.delimiter !== undefined ? opts.delimiter : o.delimiter;
  if (delimiter) {
    args.push(`delim=${quoteLit(delimiter)}`);
    // Keep the rest of the dialect (quote, escape, types) auto-detected.
    args.push(`auto_detect=true`);
  } else {
    args.push(`auto_detect=true`);
  }
  const skip = opts.skipRows ?? o.skipRows ?? 0;
  if (skip > 0) args.push(`skip=${Math.floor(skip)}`);

  // Quoting: an explicit empty quote turns it off entirely, which is how most
  // pipe- and tab-delimited exports are meant to be read.
  const quoteChar = opts.quoteChar !== undefined ? opts.quoteChar : o.quote;
  if (quoteChar === null) {
    args.push(`quote=''`);
    args.push(`escape=''`);
  } else {
    if (quoteChar !== undefined) args.push(`quote=${quoteLit(quoteChar)}`);
    if (o.escape !== undefined && o.escape !== null) args.push(`escape=${quoteLit(o.escape)}`);
  }

  // Only state the header when a person or a deliberate retry decided it.
  // Detection is a hint; DuckDB's own sniffer is better than ours and forcing
  // our guess is how a perfectly good header row ends up displayed as data.
  const header =
    opts.header !== undefined
      ? opts.header
      : o.hasHeaderExplicit && o.hasHeader !== null && o.hasHeader !== undefined
        ? o.hasHeader
        : undefined;
  if (header !== undefined) args.push(`header=${header}`);
  const encoding = opts.encoding ?? o.encoding;
  if (encoding && encoding !== 'utf-8') args.push(`encoding=${quoteLit(encoding)}`);
  args.push(`null_padding=${o.nullPadding === false ? 'false' : 'true'}`);
  args.push(`sample_size=${opts.sampleSize ?? o.sampleSize ?? 200_000}`);
  if (opts.allVarchar || o.allVarchar) args.push(`all_varchar=true`);
  if (opts.lenient || o.ignoreErrors) args.push(`ignore_errors=true`);
  if (o.columnTypes && Object.keys(o.columnTypes).length > 0) {
    const entries = Object.entries(o.columnTypes)
      .map(([k, v]) => `${quoteLit(k)}: ${quoteLit(v)}`)
      .join(', ');
    args.push(`types={${entries}}`);
  }
  return args;
}

/** Delimiters tried when neither the user nor detection settles the question. */
const FALLBACK_DELIMITERS = [',', '\t', ';', '|', '', '', '~', '^', ' '];

/** The ordered list of reader attempts for a format. */
function buildPlans(
  path: string,
  format: SourceFormat,
  o: OpenOptions,
  detectedCandidates: string[] = [],
): ReaderPlan[] {
  const p = quotePath(path);
  const plans: ReaderPlan[] = [];

  if (format === 'unsupported') {
    throw new EngineError(
      'unsupported',
      'GigaTables reads tabular files only.',
      'Supported: CSV, TSV, pipe- or otherwise-delimited text, and Parquet. ' +
        'Convert JSON to CSV first, or open it in a text editor.',
    );
  }

  if (format === 'parquet') {
    plans.push({
      strategy: 'parquet-passthrough',
      reader: `read_parquet(${p})`,
      notes: [],
      minColumns: 1,
    });
    return plans;
  }

  {
    const skip = o.skipRows ?? 0;
    const probeSample = 20_000;

    const csvPlan = (
      strategy: IngestStrategy,
      variant: CsvVariant,
      minColumns: number,
      notes: string[],
    ): ReaderPlan => {
      const full = { ...variant, skipRows: skip };
      return {
        strategy,
        reader: `read_csv(${p}, ${csvArgs(o, full).join(', ')})`,
        // Probing only needs the column list, so cap the sample. The dialect is
        // pinned by our own arguments here, so a smaller sample cannot change it.
        probeReader:
          variant.delimiter === null
            ? undefined
            : `read_csv(${p}, ${csvArgs(o, { ...full, sampleSize: probeSample }).join(', ')})`,
        notes,
        minColumns,
        delimiter: variant.delimiter !== undefined ? variant.delimiter : (o.delimiter ?? null),
        quoteChar: variant.quoteChar !== undefined ? variant.quoteChar : (o.quote ?? '"'),
        header: variant.header,
        skipRows: skip,
      };
    };

    const suggested = o.quote === undefined ? '"' : o.quote;
    // Try the quoting that detection suggested first, then the other reading. A
    // stray inch mark in an unquoted file otherwise defeats the dialect sniffer
    // for every delimiter at once, which is how a good file ends up as one column.
    const quoteOrder: (string | null)[] = suggested === null ? [null, '"'] : ['"', null];

    const quoteNote = (q: string | null) =>
      q === null ? ['Quoting was treated as off, so " is ordinary text.'] : [];

    if (o.delimiterExplicit && o.delimiter) {
      for (const q of quoteOrder) {
        plans.push(csvPlan('csv-auto', { delimiter: o.delimiter, quoteChar: q }, 1, quoteNote(q)));
      }
      for (const q of quoteOrder) {
        plans.push(
          csvPlan('csv-lenient', { delimiter: o.delimiter, quoteChar: q, lenient: true }, 1, [
            ...quoteNote(q),
            'Rows the parser rejected were skipped.',
          ]),
        );
      }
      plans.push(
        csvPlan(
          'csv-all-varchar',
          { delimiter: o.delimiter, quoteChar: quoteOrder[0]!, lenient: true, allVarchar: true },
          1,
          ['Every column was read as text because the column types conflicted.'],
        ),
      );
    } else {
      const delimiters: (string | null)[] = [null];
      for (const d of [o.delimiter ?? null, ...detectedCandidates, ...FALLBACK_DELIMITERS]) {
        if (d && !delimiters.includes(d)) delimiters.push(d);
      }

      // Pass 1: every delimiter under both quote readings, demanding a real split.
      //
      // The header=true retry sits right here, next to its own delimiter, rather
      // than after every other delimiter has been tried. Ordering matters: a file
      // whose header row has one trailing comma is a header problem, and letting
      // the ladder reach for a different delimiter first "solves" it by splitting
      // the file four ways on spaces.
      for (const d of delimiters) {
        for (const q of quoteOrder) {
          const label = [
            ...(d === null ? [] : [`Read with ${describeDelimiter(d)} as the delimiter.`]),
            ...quoteNote(q),
          ];
          plans.push(csvPlan('csv-auto', { delimiter: d, quoteChar: q }, 2, label));
          if (!o.hasHeaderExplicit) {
            plans.push(
              csvPlan('csv-auto', { delimiter: d, quoteChar: q, header: true }, 2, [
                ...label,
                'The first row was read as column names.',
              ]),
            );
          }
        }
      }

      // Pass 2: the encoding may be wrong deeper in the file than we sampled.
      // Latin-1 reads every byte, so try it before resorting to dropping rows.
      if ((o.encoding ?? 'utf-8') === 'utf-8') {
        for (const d of delimiters.slice(0, 4)) {
          for (const q of quoteOrder) {
            plans.push(
              csvPlan('csv-auto', { delimiter: d, quoteChar: q, encoding: 'latin-1' }, 2, [
                'Read as Latin-1 because the file is not valid UTF-8 throughout.',
                ...quoteNote(q),
              ]),
            );
          }
        }
      }

      // Pass 3: give up on strictness — skip bad rows, then read everything as text.
      for (const d of delimiters.slice(0, 4)) {
        for (const q of quoteOrder) {
          plans.push(
            csvPlan('csv-lenient', { delimiter: d, quoteChar: q, lenient: true }, 2, [
              ...quoteNote(q),
              'Rows the parser rejected were skipped.',
            ]),
          );
        }
      }
      for (const d of delimiters.slice(0, 4)) {
        plans.push(
          csvPlan(
            'csv-all-varchar',
            { delimiter: d, quoteChar: quoteOrder[0]!, lenient: true, allVarchar: true },
            2,
            ['Every column was read as text because the column types conflicted.'],
          ),
        );
      }

      // Pass 4: nothing split it, so it may genuinely be a single column.
      for (const q of quoteOrder) {
        plans.push(csvPlan('csv-auto', { delimiter: null, quoteChar: q }, 1, quoteNote(q)));
      }
      plans.push(
        csvPlan('csv-lenient', { delimiter: null, quoteChar: null, lenient: true }, 1, [
          'Rows the parser rejected were skipped.',
        ]),
      );
      plans.push(
        csvPlan(
          'csv-all-varchar',
          { delimiter: null, quoteChar: null, lenient: true, allVarchar: true },
          1,
          ['Every column was read as text because the column types conflicted.'],
        ),
      );
    }
  }

  // Last resort for anything text-shaped: one row per line, one column.
  plans.push({
    strategy: 'raw-lines',
    reader: `read_csv(${p}, delim='\\x00', quote='', escape='', header=false, columns={'line': 'VARCHAR'}, ignore_errors=true${
      o.encoding && o.encoding !== 'utf-8' ? `, encoding=${quoteLit(o.encoding)}` : ''
    })`,
    notes: [
      'The file could not be parsed as structured data, so it was loaded as one line per row.',
    ],
    minColumns: 1,
  });

  return plans;
}

/**
 * Do these first-row values read as column names? Judged on proportions, so one
 * odd cell among many cannot swing the answer.
 */
function looksLikeHeaderRow(values: (string | null)[]): boolean {
  const filled = values.map((v) => (v ?? '').trim()).filter((v) => v !== '');
  if (filled.length < 2) return false;
  const numericish = (v: string) => /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(v);
  if (filled.filter(numericish).length / filled.length > 0.3) return false;
  if (new Set(filled.map((v) => v.toLowerCase())).size / filled.length < 0.7) return false;
  const nameLike = (v: string) => v.length <= 64 && /^[\w .\-/()#%]+$/.test(v);
  return filled.filter(nameLike).length / filled.length >= 0.8;
}

function columnsForNote(n: number): string {
  return n === 1 ? '1 column' : `${n} columns`;
}

export function describeDelimiter(d: string | null): string {
  if (d === null) return 'auto-detected';
  switch (d) {
    case '\t':
      return 'tab';
    case ' ':
      return 'space';
    case ',':
      return 'comma';
    case ';':
      return 'semicolon';
    case '|':
      return 'pipe';
    case ':':
      return 'colon';
    default: {
      const code = d.charCodeAt(0);
      if (code < 32) return `control character 0x${code.toString(16).padStart(2, '0')}`;
      return `"${d}"`;
    }
  }
}

interface ProbedSchema {
  columns: { name: string; type: string }[];
}

async function probe(db: EngineDb, reader: string): Promise<ProbedSchema> {
  const rows = await db.queryRows(
    `DESCRIBE SELECT * FROM ${reader} LIMIT 0`,
    'reading the file structure',
  );
  return {
    columns: rows.map((r) => ({ name: r[0] ?? '', type: r[1] ?? 'VARCHAR' })),
  };
}

interface Projection {
  sql: string;
  renamed: Record<string, string>;
  notes: string[];
}

/**
 * Build the SELECT list. Two jobs: keep user column names away from the names
 * DuckDB reserves for row numbering, and optionally flatten one level of
 * STRUCTs into their own columns.
 */
function buildProjection(schema: ProbedSchema, flatten: boolean): Projection {
  const renamed: Record<string, string> = {};
  const notes: string[] = [];
  const used = new Set<string>();
  const parts: string[] = [];

  const safeName = (raw: string): string => {
    let name = raw.trim() === '' ? 'column' : raw;
    if (RESERVED_COLUMNS.has(name)) {
      let candidate = `${name}_1`;
      let n = 1;
      while (used.has(candidate)) candidate = `${name}_${++n}`;
      renamed[name] = candidate;
      notes.push(`Column "${name}" was renamed to "${candidate}" because that name is reserved.`);
      name = candidate;
    }
    if (used.has(name)) {
      let candidate = `${name}_dup`;
      let n = 1;
      while (used.has(candidate)) candidate = `${name}_dup${++n}`;
      renamed[raw] = candidate;
      notes.push(`Duplicate column "${raw}" was renamed to "${candidate}".`);
      name = candidate;
    }
    used.add(name);
    return name;
  };

  for (const col of schema.columns) {
    const isStruct = /^STRUCT\s*\(/i.test(col.type.trim());
    if (flatten && isStruct) {
      const fields = parseStructFields(col.type);
      if (fields.length > 0) {
        for (const f of fields) {
          const target = safeName(`${col.name}.${f.name}`);
          parts.push(`${quoteIdent(col.name)}.${quoteIdent(f.name)} AS ${quoteIdent(target)}`);
        }
        notes.push(`Column "${col.name}" was expanded into ${fields.length} columns.`);
        continue;
      }
    }
    const target = safeName(col.name);
    parts.push(
      target === col.name
        ? quoteIdent(col.name)
        : `${quoteIdent(col.name)} AS ${quoteIdent(target)}`,
    );
  }

  return { sql: parts.length > 0 ? parts.join(', ') : '*', renamed, notes };
}

/** Parse `STRUCT(a INTEGER, "b c" VARCHAR)` into its top-level fields. */
export function parseStructFields(type: string): { name: string; type: string }[] {
  const open = type.indexOf('(');
  const close = type.lastIndexOf(')');
  if (open < 0 || close <= open) return [];
  const body = type.slice(open + 1, close);
  const fields: { name: string; type: string }[] = [];
  let depth = 0;
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (inQuote) {
      cur += ch;
      if (ch === '"') {
        if (body[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuote = false;
      }
      continue;
    }
    if (ch === '"') {
      inQuote = true;
      cur += ch;
      continue;
    }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      fields.push(splitFieldDecl(cur));
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) fields.push(splitFieldDecl(cur));
  return fields.filter((f) => f.name !== '');
}

function splitFieldDecl(decl: string): { name: string; type: string } {
  const s = decl.trim();
  if (s.startsWith('"')) {
    let i = 1;
    let name = '';
    while (i < s.length) {
      if (s[i] === '"') {
        if (s[i + 1] === '"') {
          name += '"';
          i += 2;
          continue;
        }
        i++;
        break;
      }
      name += s[i];
      i++;
    }
    return { name, type: s.slice(i).trim() };
  }
  const sp = s.indexOf(' ');
  if (sp < 0) return { name: s, type: 'VARCHAR' };
  return { name: s.slice(0, sp), type: s.slice(sp + 1).trim() };
}

/** Transcode a non-UTF-8 file so the JSON reader (which is UTF-8 only) can read it. */
async function transcodeToUtf8(
  sourcePath: string,
  targetPath: string,
  encoding: string,
  gzipped: boolean,
  onProgress: ProgressSink,
  totalBytes: number,
): Promise<void> {
  const from = encoding === 'utf-16' ? 'utf16le' : 'latin1';
  let read = 0;
  const decoder = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      read += chunk.length;
      onProgress({
        phase: `Converting from ${encoding} to UTF-8`,
        percent: totalBytes > 0 ? Math.min(99, (read / totalBytes) * 100) : null,
        rowsDone: null,
        bytesDone: read,
        bytesTotal: totalBytes,
      });
      try {
        cb(null, Buffer.from(chunk.toString(from), 'utf8'));
      } catch (e) {
        cb(e as Error);
      }
    },
  });
  const streams: (NodeJS.ReadableStream | NodeJS.WritableStream)[] = [createReadStream(sourcePath)];
  if (gzipped) streams.push(createGunzip());
  streams.push(decoder, createWriteStream(targetPath));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await pipeline(streams as any);
}

/**
 * Ask DuckDB which delimiter its own sniffer settled on, so the UI can always
 * name the character in effect instead of just saying "auto". Best-effort: the
 * sniffer refuses on some awkward files, and that is not an error here.
 */
async function sniffDelimiter(
  db: EngineDb,
  path: string,
  o: OpenOptions,
): Promise<string | null> {
  const args = [`sample_size=${Math.min(o.sampleSize ?? 200_000, 200_000)}`, 'null_padding=true'];
  if ((o.skipRows ?? 0) > 0) args.push(`skip=${Math.floor(o.skipRows!)}`);
  if (o.encoding && o.encoding !== 'utf-8') args.push(`encoding=${quoteLit(o.encoding)}`);
  try {
    const row = await db.queryOneRow(
      `SELECT Delimiter FROM sniff_csv(${quotePath(path)}, ${args.join(', ')})`,
    );
    const d = row?.[0] ?? null;
    return d === null || d === '' ? null : d;
  } catch {
    return null;
  }
}

/**
 * Parse a handful of rows with a candidate set of options, using exactly the same
 * plan ladder as a real load. This is what lets the Open dialog show the actual
 * column split before anything is written, so a wrong delimiter is visible and
 * fixable rather than discovered after a long load.
 */
export async function previewRows(
  db: EngineDb,
  path: string,
  options: OpenOptions,
  limit: number,
): Promise<PreviewResult> {
  const st = await stat(path).catch(() => null);
  if (!st || !st.isFile()) throw new EngineError('not-found', `File not found: ${path}`);

  const detected = await detectFile(path);
  const format = options.format ?? detected.format;
  const effective: OpenOptions = {
    ...options,
    format,
    delimiter: options.delimiter ?? detected.delimiter,
    quote: options.quote !== undefined ? options.quote : detected.suggestQuote,
    hasHeader: options.hasHeader ?? detected.hasHeader,
    hasHeaderExplicit: options.hasHeaderExplicit ?? false,
    encoding: options.encoding ?? detected.encoding,
    skipRows: options.skipRows ?? detected.skipRows ?? 0,
    // A preview must be quick, so infer types from a small window.
    sampleSize: Math.min(options.sampleSize ?? 20_000, 20_000),
  };

  const plans = buildPlans(path, format, effective, detected.delimiterCandidates ?? []);
  const rowCap = Math.max(1, Math.min(Math.floor(limit), 200));
  let lastError: string | null = null;

  for (const plan of plans) {
    try {
      const described = await db.queryRows(
        `DESCRIBE SELECT * FROM ${plan.probeReader ?? plan.reader} LIMIT 0`,
        'previewing the file',
      );
      if (described.length < plan.minColumns) {
        lastError = `${describeDelimiter(plan.delimiter ?? null)} produced ${described.length} column(s).`;
        continue;
      }
      const columns = described.map((r) => ({ name: r[0] ?? '', type: r[1] ?? 'VARCHAR' }));
      const select = columns
        .map((c) => `substr(CAST(${quoteIdent(c.name)} AS VARCHAR), 1, 400) AS ${quoteIdent(c.name)}`)
        .join(', ');
      const rows = await db.queryRows(
        `SELECT ${select} FROM ${plan.probeReader ?? plan.reader} LIMIT ${rowCap}`,
        'previewing the file',
      );
      const usedDelimiter =
        plan.delimiter ?? (await sniffDelimiter(db, path, effective));
      return {
        columns,
        rows,
        usedDelimiter,
        usedFormat: format,
        usedSkipRows: plan.skipRows ?? 0,
        strategy: plan.strategy,
        warnings: [...detected.warnings, ...plan.notes],
        error: null,
      };
    } catch (err) {
      const e = err instanceof EngineError ? err : mapDuckError(err);
      if (e.code === 'cancelled') throw e;
      lastError = e.message;
    }
  }

  return {
    columns: [],
    rows: [],
    usedDelimiter: effective.delimiter ?? null,
    usedFormat: format,
    usedSkipRows: effective.skipRows ?? 0,
    strategy: 'raw-lines',
    warnings: detected.warnings,
    error: lastError ?? 'The file could not be parsed.',
  };
}

export interface IngestRequest {
  path: string;
  options: OpenOptions;
  jobId: string;
  onProgress: ProgressSink;
}

export class Ingestor {
  constructor(
    private readonly db: EngineDb,
    private readonly cache: DatasetCache,
  ) {}

  async open(req: IngestRequest): Promise<DatasetManifest> {
    const { path, options, jobId, onProgress } = req;
    const st = await stat(path).catch(() => null);
    if (!st || !st.isFile()) {
      throw new EngineError('not-found', `File not found: ${path}`);
    }

    onProgress({ phase: 'Inspecting file', percent: null, rowsDone: null, bytesDone: null, bytesTotal: st.size });

    const detected = await detectFile(path);
    const effective: OpenOptions = {
      format: options.format ?? detected.format,
      delimiter: options.delimiter ?? detected.delimiter,
      // null is meaningful here — it means "quoting off" — so ?? would lose it.
      quote: options.quote !== undefined ? options.quote : detected.suggestQuote,
      escape: options.escape ?? detected.escape,
      hasHeader: options.hasHeader ?? detected.hasHeader,
      hasHeaderExplicit: options.hasHeaderExplicit ?? false,
      delimiterExplicit: options.delimiterExplicit ?? false,
      skipRows: options.skipRows ?? detected.skipRows ?? 0,
      encoding: options.encoding ?? detected.encoding,
      allVarchar: options.allVarchar ?? false,
      ignoreErrors: options.ignoreErrors ?? false,
      nullPadding: options.nullPadding ?? true,
      sampleSize: options.sampleSize ?? 200_000,
      flatten: options.flatten ?? false,
      unorderedFast: options.unorderedFast ?? false,
      forceReingest: options.forceReingest ?? false,
      columnTypes: options.columnTypes ?? null,
    };

    const reusable = await this.cache.findReusable(path, st.size, st.mtimeMs, effective);
    if (reusable) {
      onProgress({ phase: 'Using cached copy', percent: 100, rowsDone: reusable.rowCount, bytesDone: st.size, bytesTotal: st.size });
      return { ...reusable, strategy: 'cache-hit' };
    }

    const id = this.cache.datasetId(path, st.size, st.mtimeMs, effective);
    await this.cache.prepareDir(id);
    const outPath = this.cache.basePath(id);
    const tmpOut = `${outPath}.building`;
    await rm(tmpOut, { force: true });

    const warnings = [...detected.warnings];
    const format = effective.format ?? detected.format;
    const readPath = path;

    const started = Date.now();
    const plans = buildPlans(readPath, format, effective, detected.delimiterCandidates ?? []);
    const attempts: { strategy: IngestStrategy; error: string }[] = [];

    for (let i = 0; i < plans.length; i++) {
      const plan = plans[i]!;
      {
        try {
          const manifest = await this.runPlan({
            id,
            plan,
            outPath,
            tmpOut,
            jobId,
            onProgress,
            effective,
            detected: { size: st.size, mtimeMs: st.mtimeMs, compression: detected.compression },
            sourcePath: path,
            readPath,
            format,
            warnings: [...warnings, ...plan.notes],
            attempts,
            startedAt: started,
          });
          return manifest;
        } catch (err) {
          const e = err instanceof EngineError ? err : mapDuckError(err);
          if (e.code === 'cancelled') throw e;
          if (e.code === 'out-of-memory' || e.code === 'disk-full') throw e;
          attempts.push({ strategy: plan.strategy, error: e.detail ?? e.message });
          await rm(tmpOut, { force: true });
          if (i === plans.length - 1) {
            throw new EngineError(
              'parse-failed',
              `Could not read this file. Last error: ${e.message}`,
              'Open Advanced options and set the format, delimiter or encoding by hand.',
              attempts.map((a) => `${a.strategy}: ${a.error}`).join('\n'),
            );
          }
        }
      }
    }
    throw new EngineError('internal', 'No ingest strategy ran.');
  }

  private async runPlan(args: {
    id: string;
    plan: ReaderPlan;
    outPath: string;
    tmpOut: string;
    jobId: string;
    onProgress: ProgressSink;
    effective: OpenOptions;
    detected: { size: number; mtimeMs: number; compression: DatasetManifest['compression'] };
    sourcePath: string;
    /** What was actually read: the source, or a transcoded UTF-8 copy of it. */
    readPath: string;
    format: SourceFormat;
    warnings: string[];
    attempts: { strategy: IngestStrategy; error: string }[];
    startedAt: number;
  }): Promise<DatasetManifest> {
    const {
      id,
      plan,
      outPath,
      tmpOut,
      jobId,
      onProgress,
      effective,
      detected,
      sourcePath,
      readPath,
      format,
      warnings,
      attempts,
      startedAt,
    } = args;

    onProgress({
      phase: `Reading structure (${plan.strategy})`,
      percent: null,
      rowsDone: null,
      bytesDone: null,
      bytesTotal: detected.size,
    });

    const schema = await probe(this.db, plan.probeReader ?? plan.reader);
    if (schema.columns.length === 0) {
      throw new EngineError('parse-failed', 'The file produced no columns.');
    }
    // DuckDB names columns column00, column01, … when it decides there is no
    // header. If the first row actually holds names, that is a misread worth
    // retrying rather than showing to the user.
    if (
      plan.header === undefined &&
      !effective.hasHeaderExplicit &&
      schema.columns.length > 1 &&
      schema.columns.every((c) => /^column\d+$/i.test(c.name))
    ) {
      const firstRow = await this.db
        .queryRows(`SELECT * FROM ${plan.probeReader ?? plan.reader} LIMIT 1`, 'checking for a header')
        .catch(() => [] as (string | null)[][]);
      if (firstRow[0] && looksLikeHeaderRow(firstRow[0])) {
        throw new EngineError(
          'parse-failed',
          'The first row looks like column names but was read as data.',
        );
      }
    }

    // Reading a delimited file with the wrong delimiter succeeds and returns one
    // column of whole lines. Treat that as a failed attempt while better options
    // remain, rather than showing the user a single-column table.
    if (schema.columns.length < plan.minColumns) {
      throw new EngineError(
        'parse-failed',
        `Reading with ${describeDelimiter(plan.delimiter ?? null)} produced only ` +
          `${schema.columns.length} column, so it is probably not the right delimiter.`,
      );
    }

    const extraWarnings: string[] = [];
    let fromExpr = plan.reader;
    let projection = buildProjection(schema, effective.flatten === true);

    // snappy compresses far faster than zstd (bigger cache files, but the cache
    // is disposable) — a meaningful ingest speedup, especially on slower CPUs.
    const compression = 'snappy';
    const prelude: string[] = [];
    if (effective.unorderedFast) {
      prelude.push('SET preserve_insertion_order=false');
      extraWarnings.push('Fast ingest was used, so row order may not match the file.');
    } else {
      prelude.push('SET preserve_insertion_order=true');
    }

    const copySql = `COPY (SELECT ${projection.sql} FROM ${fromExpr}) TO ${quotePath(tmpOut)} (FORMAT parquet, COMPRESSION ${compression}, ROW_GROUP_SIZE ${ROW_GROUP_SIZE})`;

    let lastRows = 0;
    await this.db.runJob(
      jobId,
      [...prelude, copySql],
      (percent, rowsDone, rowsTotal) => {
        if (rowsDone !== null) lastRows = rowsDone;
        onProgress({
          phase: 'Loading into the query engine',
          percent,
          rowsDone,
          bytesDone: rowsTotal && rowsDone !== null && rowsTotal > 0
            ? Math.round((rowsDone / rowsTotal) * detected.size)
            : null,
          bytesTotal: detected.size,
        });
      },
      'loading the file',
    );

    void lastRows;
    await rename(tmpOut, outPath);

    onProgress({
      phase: 'Finalising',
      percent: 99,
      rowsDone: null,
      bytesDone: detected.size,
      bytesTotal: detected.size,
    });

    const rowCountText = await this.db.queryScalar(
      `SELECT sum(num_rows)::BIGINT FROM parquet_file_metadata(${quotePath(outPath)})`,
      'counting rows',
    );
    const rowCount = Number(rowCountText ?? '0');

    const finalSchema = await this.db.queryRows(
      `DESCRIBE SELECT * FROM read_parquet(${quotePath(outPath)}) LIMIT 0`,
      'reading the loaded schema',
    );
    const columns: ColumnInfo[] = finalSchema.map((r) => {
      const name = r[0] ?? '';
      const type = r[1] ?? 'VARCHAR';
      const original = Object.entries(projection.renamed).find(([, v]) => v === name)?.[0];
      return describeColumn(name, type, original);
    });

    const parquetBytes = await fileSize(outPath);
    // Report the options that were actually used, not the ones guessed up front.
    let resolvedDelimiter = plan.delimiter ?? null;
    if (resolvedDelimiter === null && plan.strategy !== 'raw-lines') {
      resolvedDelimiter = await sniffDelimiter(this.db, readPath, effective);
    }
    const usedOptions: OpenOptions =
      plan.delimiter !== undefined || resolvedDelimiter !== null
        ? {
            ...effective,
            delimiter: resolvedDelimiter,
            quote: plan.quoteChar !== undefined ? plan.quoteChar : effective.quote,
            skipRows: plan.skipRows ?? effective.skipRows,
          }
        : effective;
    if (
      plan.delimiter !== undefined &&
      plan.delimiter !== null &&
      plan.delimiter !== effective.delimiter
    ) {
      extraWarnings.push(
        `Loaded using ${describeDelimiter(plan.delimiter)} as the delimiter (${columnsForNote(
          schema.columns.length,
        )}).`,
      );
    }

    const manifest: DatasetManifest = {
      version: MANIFEST_VERSION,
      id,
      sourcePath,
      sourceName: basename(sourcePath),
      sourceSize: detected.size,
      sourceMtimeMs: detected.mtimeMs,
      format,
      compression: detected.compression,
      options: usedOptions,
      parquetPath: outPath,
      parquetBytes,
      rowCount,
      columns,
      ingestedAtMs: Date.now(),
      ingestMs: Date.now() - startedAt,
      strategy: plan.strategy,
      attempts,
      warnings: dedupe([...warnings, ...extraWarnings, ...projection.notes]),
      renamedColumns: projection.renamed,
    };

    if (columns.some((c) => isNestedType(c.type))) {
      manifest.warnings.push(
        'Some columns hold nested values. The grid shows them as JSON; use the row inspector to expand them.',
      );
    }

    await this.cache.writeManifest(manifest);
    onProgress({
      phase: 'Ready',
      percent: 100,
      rowsDone: rowCount,
      bytesDone: detected.size,
      bytesTotal: detected.size,
    });
    return manifest;
  }
}

function dedupe(items: string[]): string[] {
  return [...new Set(items.filter((s) => s.trim().length > 0))];
}

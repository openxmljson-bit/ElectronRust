/**
 * Format sniffing that only ever reads the head of a file, so pointing the app
 * at a 20 GB file costs a few milliseconds before the user decides anything.
 */

import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { createGunzip } from 'node:zlib';
import type { Compression, DetectResult, SourceFormat } from '../shared/protocol.js';

const HEAD_BYTES = 256 * 1024;
const SAMPLE_CHARS = 8000;

/**
 * Delimiters worth trying, most conventional first. The order doubles as a
 * tie-break: when two characters split a file equally well, the conventional one
 * wins. Space and colon are last because they occur inside ordinary values.
 */
const DELIMITER_CANDIDATES = [
  ',',
  '\t',
  ';',
  '|',
  '\u0001', // SOH — Hive and other big-data exports
  '\u001f', // unit separator
  '~',
  '^',
  '\u0000',
  ' ',
  ':',
];

export async function readHead(path: string, bytes = HEAD_BYTES): Promise<Buffer> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** Read a window from anywhere in a file. */
async function readAt(path: string, offset: number, bytes: number): Promise<Buffer> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, offset);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** Drop bytes at both edges that may be halves of a multi-byte character. */
function trimPartialEdges(buf: Buffer): Buffer {
  let start = 0;
  while (start < buf.length && start < 4 && (buf[start]! & 0xc0) === 0x80) start++;
  return buf.subarray(start);
}

function detectCompression(head: Buffer): Compression {
  if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) return 'gzip';
  if (
    head.length >= 4 &&
    head[0] === 0x28 &&
    head[1] === 0xb5 &&
    head[2] === 0x2f &&
    head[3] === 0xfd
  )
    return 'zstd';
  return 'none';
}

async function gunzipHead(path: string, bytes: number): Promise<Buffer> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const src = createReadStream(path);
    const gz = createGunzip();
    const finish = (err?: Error) => {
      src.destroy();
      gz.destroy();
      if (err && total === 0) reject(err);
      else resolve(Buffer.concat(chunks).subarray(0, bytes));
    };
    gz.on('data', (c: Buffer) => {
      chunks.push(c);
      total += c.length;
      if (total >= bytes) finish();
    });
    gz.on('end', () => finish());
    gz.on('error', (e) => finish(e as Error));
    src.on('error', (e) => finish(e as Error));
    src.pipe(gz);
  });
}

function isValidUtf8(buf: Buffer): boolean {
  // Ignore a trailing partial sequence: we only ever look at a prefix of the file.
  let end = buf.length;
  for (let back = 0; back < 4 && end > 0; back++) {
    const b = buf[end - 1]!;
    if ((b & 0xc0) === 0x80) {
      end--;
      continue;
    }
    if (b >= 0xc0) end--;
    break;
  }
  const slice = buf.subarray(0, end);
  const decoded = slice.toString('utf8');
  return !decoded.includes('�');
}

interface EncodingGuess {
  encoding: string;
  bomBytes: number;
  warnings: string[];
}

function detectEncoding(buf: Buffer): EncodingGuess {
  const warnings: string[] = [];
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { encoding: 'utf-8', bomBytes: 3, warnings };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { encoding: 'utf-16', bomBytes: 2, warnings };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    warnings.push('UTF-16 big-endian detected; DuckDB reads UTF-16 little-endian best.');
    return { encoding: 'utf-16', bomBytes: 2, warnings };
  }
  if (isValidUtf8(buf)) return { encoding: 'utf-8', bomBytes: 0, warnings };
  // A lot of zero bytes in even positions is unmarked UTF-16LE.
  let zeros = 0;
  const probe = Math.min(buf.length, 2000);
  for (let i = 1; i < probe; i += 2) if (buf[i] === 0) zeros++;
  if (zeros > probe / 4) {
    warnings.push('File looks like UTF-16 without a byte-order mark.');
    return { encoding: 'utf-16', bomBytes: 0, warnings };
  }
  warnings.push('File is not valid UTF-8; reading it as Latin-1. Override in Advanced options if wrong.');
  return { encoding: 'latin-1', bomBytes: 0, warnings };
}

function decode(buf: Buffer, encoding: string, bomBytes: number): string {
  const body = buf.subarray(bomBytes);
  if (encoding === 'utf-16') return body.toString('utf16le');
  if (encoding === 'latin-1') return body.toString('latin1');
  return body.toString('utf8');
}

/** Split into lines, dropping the last (likely truncated) one. */
function sampleLines(text: string, max = 200): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length > 1) lines.pop();
  return lines.slice(0, max);
}

interface DelimiterGuess {
  delimiter: string | null;
  hasHeader: boolean | null;
  confidence: number;
  /** Preamble lines before the first real row (a title line, an export banner). */
  skipRows: number;
  /** Every candidate that plausibly splits the file, best first. */
  ranked: string[];
  /** '"' when the file looks properly quoted, null when quoting should be off. */
  suggestQuote: string | null;
}

/**
 * Pick the delimiter that splits the sample most consistently.
 *
 * Scoring is on the *modal* field count rather than the first line's count. That
 * matters more than it sounds: anchoring on line 0 means a file with a title line
 * above its header ("Sales export 2026") scores every candidate as one field and
 * detects no delimiter at all — which is precisely how a delimited file ends up
 * displayed as a single column.
 */
function guessDelimiter(lines: string[]): DelimiterGuess {
  const usable = lines.filter((l) => l.trim().length > 0).slice(0, 60);
  const empty: DelimiterGuess = {
    delimiter: null,
    hasHeader: null,
    confidence: 0,
    skipRows: 0,
    ranked: [],
    suggestQuote: '"',
  };
  if (usable.length === 0) return empty;

  interface Candidate {
    delim: string;
    fields: number;
    score: number;
    firstMatch: number;
    respectQuotes: boolean;
  }

  const scored: Candidate[] = [];

  for (const [preference, delim] of DELIMITER_CANDIDATES.entries()) {
    for (const respectQuotes of [true, false]) {
    const counts = usable.map((l) => countFields(l, delim, respectQuotes));

    // Modal field count, ignoring lines that show no split at all.
    const freq = new Map<number, number>();
    for (const c of counts) {
      if (c < 2) continue;
      freq.set(c, (freq.get(c) ?? 0) + 1);
    }
    if (freq.size === 0) continue;

    let modeCount = 0;
    let modeHits = 0;
    for (const [count, hits] of freq) {
      if (hits > modeHits || (hits === modeHits && count > modeCount)) {
        modeCount = count;
        modeHits = hits;
      }
    }

    const consistency = modeHits / counts.length;
    // Consistency dominates; field count breaks near-ties; the preference index
    // settles the rest so a comma beats a space on equal evidence. Quote-aware
    // readings win ties, since well-formed quoting is the commoner case.
    const score =
      consistency * 1000 + Math.min(modeCount, 40) * 5 - preference + (respectQuotes ? 0.5 : 0);
    scored.push({
      delim,
      fields: modeCount,
      score,
      // Preamble means a line that does not split at all — a title or a banner.
      // A header row that merely has one field more or fewer than the body (a
      // trailing comma, say) is not preamble, and skipping it would promote the
      // first data row into the column names.
      firstMatch: Math.max(0, counts.findIndex((c) => c >= 2)),
      respectQuotes,
    });
    }
  }

  if (scored.length === 0) return { ...empty, confidence: 0.2 };

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0]!;
  const skipRows = Math.max(0, best.firstMatch);

  const rows = usable.slice(skipRows);
  const headerFields = rows[0] ? splitFields(rows[0], best.delim, best.respectQuotes) : [];
  const secondFields = rows[1] ? splitFields(rows[1], best.delim, best.respectQuotes) : null;
  const hasHeader = headerFields.length > 0 ? guessHeader(headerFields, secondFields) : null;

  // A clean split of every line is ~0.95; a ragged one drops away from there.
  const consistency = (best.score + DELIMITER_CANDIDATES.length) / 1000;
  // Dedupe the ranking: the same delimiter may appear under both quote readings.
  const ranked: string[] = [];
  for (const c of scored) if (!ranked.includes(c.delim)) ranked.push(c.delim);

  return {
    delimiter: best.delim,
    hasHeader,
    confidence: Math.max(0.2, Math.min(0.95, consistency * 0.95)),
    skipRows,
    ranked,
    suggestQuote: best.respectQuotes ? '"' : null,
  };
}

function countFields(line: string, delim: string, respectQuotes = true): number {
  return splitFields(line, delim, respectQuotes).length;
}

/**
 * Split a line on `delim`.
 *
 * `respectQuotes` matters more than it looks. Product data is full of inch marks
 * ("Hose 3/4\" NPT"), and in an unquoted pipe-delimited file those are ordinary
 * characters. Treating them as quotes swallows the rest of the line, wrecks the
 * field counts, and makes detection pick nonsense. So callers try both readings
 * and keep whichever is more consistent.
 */
function splitFields(line: string, delim: string, respectQuotes = true): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuote) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuote = false;
      } else cur += ch;
      continue;
    }
    if (ch === '"' && respectQuotes) {
      inQuote = true;
      continue;
    }
    if (ch === delim) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * Does the first row look like column names rather than data?
 *
 * This is a *hint* for the preview only — the reader lets DuckDB decide unless
 * a person says otherwise. It is scored on proportions rather than absolutes
 * because the old all-or-nothing version failed on ordinary files: one repeated
 * name, one trailing comma, or one column called "2024" among 57 headers was
 * enough to declare the header row to be data.
 */
function guessHeader(first: string[], second: string[] | null): boolean {
  const numericish = (s: string) =>
    s !== '' && /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s.trim());

  const cells = first.map((c) => c.trim());
  const filled = cells.filter((c) => c !== '');
  if (filled.length === 0) return false;

  const numericShare = filled.filter(numericish).length / filled.length;
  // A header of mostly numbers is data. A stray "2024" among names is not.
  if (numericShare > 0.3) return false;

  const distinctShare = new Set(filled.map((c) => c.toLowerCase())).size / filled.length;
  if (distinctShare < 0.7) return false;

  if (!second) return true;

  // The clearest signal: the row below is typed differently from this one.
  const secondFilled = second.map((c) => c.trim()).filter((c) => c !== '');
  if (secondFilled.length === 0) return true;
  const secondNumericShare = secondFilled.filter(numericish).length / secondFilled.length;
  if (secondNumericShare > numericShare) return true;

  // Otherwise fall back to headers usually being short, wordy and unpunctuated.
  const looksLikeName = (c: string) => /^[\w .\-/()#%]+$/.test(c) && c.length <= 64;
  return filled.filter(looksLikeName).length / filled.length >= 0.8;
}

function formatFromExtension(path: string): SourceFormat | null {
  const ext = extname(path).toLowerCase().replace(/\.(gz|zst|zstd)$/, '');
  switch (ext) {
    case '.json':
    case '.ndjson':
    case '.jsonl':
    case '.jsonlines':
      return 'unsupported';
    case '.csv':
      return 'csv';
    case '.tsv':
    case '.tab':
      return 'tsv';
    case '.txt':
    case '.dat':
      return 'delimited';
    case '.psv':
      return 'psv';
    case '.parquet':
    case '.pq':
      return 'parquet';
    default:
      return null;
  }
}

export async function detectFile(path: string): Promise<DetectResult> {
  const st = await stat(path);
  if (!st.isFile()) {
    throw Object.assign(new Error(`Not a file: ${path}`), { code: 'invalid-request' });
  }
  const rawHead = await readHead(path, 4096);
  const compression = detectCompression(rawHead);

  const warnings: string[] = [];
  let head: Buffer;
  if (compression === 'gzip') {
    try {
      head = await gunzipHead(path, HEAD_BYTES);
    } catch {
      head = Buffer.alloc(0);
      warnings.push('Could not decompress the start of this gzip file.');
    }
  } else if (compression === 'zstd') {
    head = Buffer.alloc(0);
    warnings.push('Zstandard files are read by DuckDB but cannot be previewed before loading.');
  } else {
    head = await readHead(path, HEAD_BYTES);
  }

  if (head.length >= 4 && head.subarray(0, 4).toString('latin1') === 'PAR1') {
    return {
      path,
      name: basename(path),
      sizeBytes: st.size,
      mtimeMs: st.mtimeMs,
      format: 'parquet',
      compression: 'none',
      encoding: 'binary',
      delimiter: null,
      quote: null,
      escape: null,
      hasHeader: null,
      confidence: 1,
      skipRows: 0,
      delimiterCandidates: [],
      suggestQuote: null,
      sampleText: '(Parquet file — columnar binary format)',
      warnings,
      cached: false,
    };
  }

  const enc = detectEncoding(head);
  warnings.push(...enc.warnings);

  // The head can be clean UTF-8 while a high byte sits at row 400,000. That
  // single byte fails the whole read, so probe a few windows further in.
  if (enc.encoding === 'utf-8' && compression === 'none' && st.size > HEAD_BYTES) {
    const probes = [0.25, 0.5, 0.9].map((f) => Math.floor(st.size * f));
    for (const offset of probes) {
      const chunk = await readAt(path, offset, 64 * 1024).catch(() => null);
      if (chunk && chunk.length > 8 && !isValidUtf8(trimPartialEdges(chunk))) {
        enc.encoding = 'latin-1';
        warnings.push(
          'Bytes further into the file are not valid UTF-8, so it is read as Latin-1. ' +
            'Override the encoding in Advanced options if that is wrong.',
        );
        break;
      }
    }
  }
  const text = decode(head, enc.encoding, enc.bomBytes);
  const lines = sampleLines(text);
  const extHint = formatFromExtension(path);

  let format: SourceFormat = 'unknown';
  let confidence = 0.3;
  let delimiter: string | null = null;
  let hasHeader: boolean | null = null;
  let skipRows = 0;
  let delimiterCandidates: string[] = [];
  let suggestQuote: string | null = '"';

  const trimmedStart = text.replace(/^[\s﻿]+/, '');
  const firstChar = trimmedStart[0] ?? '';

  if (firstChar === '[' || firstChar === '{') {
    // JSON is deliberately out of scope: a document format does not belong in a
    // table view. Say so plainly rather than half-parsing it into columns.
    format = 'unsupported';
    confidence = 0.95;
    warnings.push(
      'This looks like JSON. GigaTables reads tabular files only — CSV, TSV, ' +
        'pipe- or otherwise-delimited text, and Parquet.',
    );
  } else if (firstChar === '') {
    format = extHint ?? 'unknown';
    confidence = 0.1;
    warnings.push('File appears to be empty.');
  } else {
    const g = guessDelimiter(lines);
    delimiter = g.delimiter;
    hasHeader = g.hasHeader;
    confidence = g.confidence;
    skipRows = g.skipRows;
    delimiterCandidates = g.ranked;
    suggestQuote = g.suggestQuote;
    if (suggestQuote === null && g.delimiter !== null) {
      warnings.push(
        'The file contains unpaired quote characters, so quoting is treated as off and " is read as ordinary text.',
      );
    }
    if (skipRows > 0) {
      warnings.push(
        `The first ${skipRows} line(s) look like a preamble rather than data, so they are skipped.`,
      );
    }
    if (delimiter === '\t') format = 'tsv';
    else if (delimiter === ',') format = 'csv';
    else if (delimiter === '|') format = 'psv';
    else if (delimiter) format = 'delimited';
    else {
      format = extHint ?? 'delimited';
      warnings.push(
        'No delimiter was found in the sample. The file will be loaded as single-column text — ' +
          'set the delimiter by hand if that is wrong.',
      );
    }
  }

  if (extHint && extHint !== format) {
    const delimFamily = new Set<SourceFormat>(['csv', 'tsv', 'psv', 'delimited']);
    const sameFamily = delimFamily.has(extHint) && delimFamily.has(format);
    if (!sameFamily) {
      warnings.push(
        `Extension suggests ${extHint} but the content looks like ${format}. Using the content.`,
      );
      confidence = Math.min(confidence, 0.55);
    }
  }

  return {
    path,
    name: basename(path),
    sizeBytes: st.size,
    mtimeMs: st.mtimeMs,
    format,
    compression,
    encoding: enc.encoding,
    delimiter,
    quote: delimiter ? '"' : null,
    escape: delimiter ? '"' : null,
    hasHeader,
    confidence,
    skipRows,
    delimiterCandidates,
    suggestQuote,
    sampleText: text.slice(0, SAMPLE_CHARS),
    warnings,
    cached: false,
  };
}

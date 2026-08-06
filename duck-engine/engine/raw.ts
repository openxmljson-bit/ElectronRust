/**
 * Raw file view. Reads a bounded window of bytes straight from disk so the user
 * can look at the actual text of a 20 GB file — including the exact bytes that
 * made a parse fail — without anything trying to load the whole thing.
 */

import { open, stat } from 'node:fs/promises';
import type { RawSlice } from '../shared/protocol.js';
import { EngineError } from './db.js';

export const MAX_SLICE = 4 * 1024 * 1024;

export async function rawSlice(path: string, offset: number, length: number): Promise<RawSlice> {
  const st = await stat(path).catch(() => null);
  if (!st || !st.isFile()) throw new EngineError('not-found', `File not found: ${path}`);

  const total = st.size;
  const want = Math.max(1, Math.min(Math.floor(length), MAX_SLICE));
  const start = Math.max(0, Math.min(Math.floor(offset), Math.max(0, total - 1)));

  // Read a little before and after so we can trim to whole lines.
  const padBefore = start > 0 ? Math.min(4096, start) : 0;
  const readStart = start - padBefore;
  const readLen = Math.min(want + padBefore + 4096, total - readStart);

  const fh = await open(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(readLen);
    const { bytesRead } = await fh.read(buf, 0, readLen, readStart);
    const slice = buf.subarray(0, bytesRead);

    let from = padBefore;
    if (start > 0) {
      // Advance to just after the previous newline so the first line is whole.
      const nl = slice.indexOf(0x0a, Math.max(0, padBefore - 1));
      const back = slice.lastIndexOf(0x0a, padBefore);
      if (back >= 0) from = back + 1;
      else if (nl >= 0 && nl < padBefore) from = nl + 1;
    }

    let to = Math.min(from + want, slice.length);
    if (to < slice.length) {
      const lastNl = slice.lastIndexOf(0x0a, to);
      if (lastNl > from) to = lastNl + 1;
    }

    const text = slice.subarray(from, to).toString('utf8');
    const lineStartOffset = readStart + from;
    return {
      path,
      offset: lineStartOffset,
      length: to - from,
      totalBytes: total,
      text,
      lineStartOffset,
      atEnd: readStart + to >= total,
    };
  } finally {
    await fh.close();
  }
}

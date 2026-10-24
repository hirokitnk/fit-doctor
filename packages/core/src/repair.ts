import { writeUint32LE } from './bytes.js';
import { FILE_CRC_SIZE, recomputeCrc } from './header.js';
import { type DefinitionMessage, type FitRecord, type FitStructure, parseStructure } from './structure.js';
import { FIELD_TIMESTAMP } from './summary.js';
import { readValidUnsigned } from './values.js';

export interface RepairResult<R> {
  /** Output file. A fresh copy even when nothing changed. */
  bytes: Uint8Array;
  /** False when the input had nothing to repair; `bytes` is then byte-identical to the input. */
  changed: boolean;
  report: R;
}

/** Thrown when a file is not structurally sound enough to be modified safely. */
export class FitStructureError extends Error {
  constructor(
    message: string,
    readonly structure: FitStructure,
  ) {
    super(message);
    this.name = 'FitStructureError';
  }
}

/** Parses `bytes` and refuses to continue if the structure has any error. */
export function parseForRepair(bytes: Uint8Array): FitStructure {
  const structure = parseStructure(bytes);
  if (structure.header === null || structure.errors.length > 0) {
    const first = structure.errors[0];
    throw new FitStructureError(`refusing to modify a malformed FIT file: ${first?.message ?? 'unknown error'}`, structure);
  }
  return structure;
}

/**
 * Per record: undefined keeps it byte-for-byte, null drops it, a Uint8Array replaces it.
 */
export type RecordEdit = (record: FitRecord) => Uint8Array | null | undefined;

/**
 * Rebuilds a file by copying the header, the (edited) records and any trailing bytes, then
 * rewrites `data size` and both CRCs. Records the edit leaves alone are copied verbatim.
 */
export function rewriteRecords(bytes: Uint8Array, structure: FitStructure, edit: RecordEdit): Uint8Array {
  const pieces: Uint8Array[] = [];
  let dataSize = 0;
  for (const record of structure.records) {
    const replacement = edit(record);
    if (replacement === null) continue;
    const piece = replacement ?? bytes.subarray(record.offset, record.offset + record.length);
    pieces.push(piece);
    dataSize += piece.length;
  }
  const trailing = bytes.subarray(structure.dataEnd + FILE_CRC_SIZE);
  const out = new Uint8Array(structure.dataStart + dataSize + FILE_CRC_SIZE + trailing.length);
  out.set(bytes.subarray(0, structure.dataStart), 0);
  let pos = structure.dataStart;
  for (const piece of pieces) {
    out.set(piece, pos);
    pos += piece.length;
  }
  out.set(trailing, pos + FILE_CRC_SIZE);
  writeUint32LE(out, 4, dataSize);
  return recomputeCrc(out);
}

/**
 * Timestamps a decoder would assign to compressed-timestamp data messages, in file order.
 * The reference is the last full timestamp (field 253) of any data message. null when no
 * reference exists yet.
 */
export function compressedTimestamps(bytes: Uint8Array, structure: FitStructure): (number | null)[] {
  const out: (number | null)[] = [];
  let last: number | null = null;
  for (const r of structure.records) {
    if (r.kind !== 'data') continue;
    if (r.compressedTimestamp) {
      if (last === null) {
        out.push(null);
        continue;
      }
      const offset = r.timeOffset as number;
      last = last + ((offset - (last & 0x1f)) & 0x1f);
      out.push(last);
      continue;
    }
    const definition = structure.records[r.definitionIndex] as DefinitionMessage;
    const ts = readValidUnsigned(bytes, definition, r, FIELD_TIMESTAMP, 4);
    if (ts !== null) last = ts;
  }
  return out;
}

/**
 * Number of retained compressed-timestamp messages whose decoded timestamp differs between
 * two files. `kept` lists, for each compressed message of `before`, whether it survives.
 */
export function countCompressedShifts(
  before: (number | null)[],
  kept: boolean[],
  after: (number | null)[],
): number {
  const retained = before.filter((_, i) => kept[i]);
  if (retained.length !== after.length) {
    throw new Error(`internal: ${retained.length} retained compressed messages but ${after.length} in output`);
  }
  return retained.reduce((n: number, ts, i) => n + (ts === after[i] ? 0 : 1), 0);
}

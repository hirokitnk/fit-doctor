import type { FitStructure } from '../../src/structure.js';

/** Byte slices of every record, in file order. */
export function recordSlices(bytes: Uint8Array, structure: FitStructure): number[][] {
  return structure.records.map((r) => Array.from(bytes.subarray(r.offset, r.offset + r.length)));
}

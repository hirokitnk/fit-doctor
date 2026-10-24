// Minimal hand-assembly helpers for stage-1 parser tests.
// These build exact byte sequences so tests can assert offsets precisely.
import { crc16 } from '../../src/crc.js';

export const BaseType = {
  enum: 0x00,
  uint8: 0x02,
  uint16: 0x84,
  uint32: 0x86,
  string: 0x07,
  uint32z: 0x8c,
  byte: 0x0d,
} as const;

export function u16(value: number, bigEndian = false): number[] {
  const b = [value & 0xff, (value >>> 8) & 0xff];
  return bigEndian ? b.reverse() : b;
}

export function u32(value: number, bigEndian = false): number[] {
  const b = [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
  return bigEndian ? b.reverse() : b;
}

export interface DefOptions {
  bigEndian?: boolean;
  /** [field number, size, developer data index] */
  devFields?: [number, number, number][];
  /** Set bit 5 even when devFields is empty. */
  forceDevFlag?: boolean;
}

/** [field def number, size, base type] */
export type FieldSpec = [number, number, number];

export function defMsg(localType: number, globalMesgNum: number, fields: FieldSpec[], opts: DefOptions = {}): number[] {
  const hasDev = opts.devFields !== undefined || opts.forceDevFlag === true;
  const out = [0x40 | (hasDev ? 0x20 : 0) | (localType & 0x0f), 0, opts.bigEndian ? 1 : 0];
  out.push(...u16(globalMesgNum, opts.bigEndian), fields.length);
  for (const f of fields) out.push(...f);
  if (hasDev) {
    const dev = opts.devFields ?? [];
    out.push(dev.length);
    for (const d of dev) out.push(...d);
  }
  return out;
}

export function dataMsg(localType: number, content: number[]): number[] {
  return [localType & 0x0f, ...content];
}

export function compressedMsg(localType: number, timeOffset: number, content: number[]): number[] {
  return [0x80 | ((localType & 0x03) << 5) | (timeOffset & 0x1f), ...content];
}

export interface FileOptions {
  headerSize?: 12 | 14;
  protocolVersion?: number;
  profileVersion?: number;
  /** Override the stored header CRC (14-byte headers only). */
  headerCrc?: number;
  /** Override the declared data size. */
  dataSize?: number;
}

export function fitFile(records: number[][], opts: FileOptions = {}): Uint8Array {
  const headerSize = opts.headerSize ?? 14;
  const body = records.flat();
  const header = [headerSize, opts.protocolVersion ?? 0x20, ...u16(opts.profileVersion ?? 21218)];
  header.push(...u32(opts.dataSize ?? body.length), 0x2e, 0x46, 0x49, 0x54); // ".FIT"
  if (headerSize === 14) {
    const crc = opts.headerCrc ?? crc16(Uint8Array.from(header));
    header.push(...u16(crc));
  }
  const withoutCrc = Uint8Array.from([...header, ...body]);
  return Uint8Array.from([...withoutCrc, ...u16(crc16(withoutCrc))]);
}

/** Deterministic PRNG (mulberry32) so random-input tests are reproducible. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomBytes(rand: () => number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = Math.floor(rand() * 256);
  return out;
}

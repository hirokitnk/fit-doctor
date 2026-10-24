import { CrcCalculator } from '@garmin/fitsdk';
import { describe, expect, it } from 'vitest';
import { crc16, crc16Update } from '../src/crc.js';
import { parseHeader, recomputeCrc } from '../src/header.js';
import { BaseType, dataMsg, defMsg, fitFile, prng, randomBytes, u32 } from './helpers/fit-bytes.js';
import { sdkCheck } from '@fit-doctor/fixtures/sdk';

const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

/** Bit-by-bit CRC-16/ARC (poly 0x8005 reflected = 0xA001, init 0), independent of the nibble table. */
function crc16Reference(bytes: Uint8Array): number {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
  }
  return crc;
}

describe('crc16', () => {
  it('matches the CRC-16/ARC check value for "123456789"', () => {
    expect(crc16(ascii('123456789'))).toBe(0xbb3d);
  });

  it('matches known single-byte and empty values', () => {
    expect(crc16(new Uint8Array())).toBe(0x0000);
    expect(crc16(Uint8Array.of(0x00))).toBe(0x0000);
    expect(crc16(Uint8Array.of(0x01))).toBe(0xc0c1);
    expect(crc16(Uint8Array.of(0xff))).toBe(0x4040);
    expect(crc16(ascii('A'))).toBe(0x30c0);
  });

  it('matches a known 14-byte FIT header CRC', () => {
    // 14-byte header: size 14, protocol 0x10, profile 2093 (0x082D), data size 0x0000_1234, ".FIT"
    const header = Uint8Array.of(0x0e, 0x10, 0x2d, 0x08, 0x34, 0x12, 0x00, 0x00, 0x2e, 0x46, 0x49, 0x54);
    expect(crc16(header)).toBe(crc16Reference(header));
    expect(crc16(header)).toBe(CrcCalculator.calculateCRC(header, 0, 12));
  });

  it('agrees with a bitwise reference and with the Garmin SDK on random input', () => {
    const rand = prng(0xf17);
    for (let n = 0; n < 200; n++) {
      const buf = randomBytes(rand, Math.floor(rand() * 300));
      const expected = crc16Reference(buf);
      expect(crc16(buf)).toBe(expected);
      expect(CrcCalculator.calculateCRC(buf, 0, buf.length)).toBe(expected);
    }
  });

  it('honours start/end bounds and can be continued via `initial`', () => {
    const rand = prng(42);
    const buf = randomBytes(rand, 128);
    expect(crc16(buf, 10, 90)).toBe(crc16Reference(buf.subarray(10, 90)));
    expect(crc16(buf, 64, 128, crc16(buf, 0, 64))).toBe(crc16(buf));
    let running = 0;
    for (const b of buf) running = crc16Update(running, b);
    expect(running).toBe(crc16(buf));
  });

  it('yields 0 when the little-endian CRC is appended (residue property)', () => {
    const buf = ascii('fit-doctor');
    const crc = crc16(buf);
    expect(crc16(Uint8Array.from([...buf, crc & 0xff, crc >> 8]))).toBe(0);
  });
});

describe('recomputeCrc', () => {
  const sample = (headerSize: 12 | 14) =>
    fitFile([defMsg(0, 20, [[253, 4, BaseType.uint32]]), dataMsg(0, u32(1_000_000_000))], { headerSize });

  it('restores corrupted header and file CRCs, without mutating the input', () => {
    const good = sample(14);
    const bad = good.slice();
    bad[12] ^= 0xff;
    bad[bad.length - 1] ^= 0x55;
    const snapshot = bad.slice();

    const fixed = recomputeCrc(bad);
    expect(fixed).toEqual(good);
    expect(bad).toEqual(snapshot);
    expect(fixed).not.toBe(bad);
    expect(sdkCheck(fixed).integrity).toBe(true);
  });

  it('is the identity on a file whose CRCs are already correct', () => {
    const good = sample(14);
    expect(recomputeCrc(good)).toEqual(good);
  });

  it('only touches the file CRC for 12-byte headers', () => {
    const good = sample(12);
    const bad = good.slice();
    bad[bad.length - 2] ^= 0x01;
    const fixed = recomputeCrc(bad);
    expect(fixed).toEqual(good);
    expect(parseHeader(fixed)).toMatchObject({ ok: true, header: { headerSize: 12, headerCrc: null } });
  });

  it('overwrites a 0x0000 header CRC with the real value', () => {
    const zero = fitFile([], { headerCrc: 0 });
    const fixed = recomputeCrc(zero);
    expect(fixed[12] | (fixed[13] << 8)).toBe(crc16(zero, 0, 12));
  });

  it('preserves bytes after the file CRC', () => {
    const good = sample(14);
    const chained = Uint8Array.from([...good, 0xde, 0xad]);
    chained[chained.length - 3] ^= 0xff; // corrupt file CRC high byte
    expect(recomputeCrc(chained)).toEqual(Uint8Array.from([...good, 0xde, 0xad]));
  });

  it('throws on a file that is not FIT or is truncated', () => {
    expect(() => recomputeCrc(ascii('not a fit file'))).toThrow(/header size/);
    expect(() => recomputeCrc(sample(14).subarray(0, 20))).toThrow(/declares/);
  });
});

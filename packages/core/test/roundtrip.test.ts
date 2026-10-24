import { MesgNum, PRESET_NAMES, crc16Bitwise, preset } from '@fit-doctor/fixtures';
import { describe, expect, it } from 'vitest';
import { recomputeCrc } from '../src/header.js';
import { type DataMessage, type DefinitionMessage, parseStructure, readFieldUnsigned } from '../src/structure.js';

describe.each(PRESET_NAMES)('round trip: %s', (name) => {
  const { bytes, truth } = preset(name);
  const s = parseStructure(bytes);
  const defs = s.records.filter((r): r is DefinitionMessage => r.kind === 'definition');
  const data = s.records.filter((r): r is DataMessage => r.kind === 'data');
  const defOf = (m: DataMessage) => s.records[m.definitionIndex] as DefinitionMessage;
  const read = (mesgNum: number, field: number) =>
    data.filter((m) => m.globalMesgNum === mesgNum).map((m) => readFieldUnsigned(bytes, defOf(m), m, field));

  it('parses without structural errors and with valid CRCs', () => {
    expect(s.errors).toEqual([]);
    expect(s.fileCrc?.valid).toBe(true);
    expect(s.headerCrcStatus).toBe(
      truth.options.headerSize === 12 ? 'absent' : truth.options.headerCrc === 'zero' ? 'zero' : 'valid',
    );
    expect(s.trailingBytes).toBe(0);
    expect(s.fileCrc?.computed).toBe(crc16Bitwise(bytes, 0, s.dataEnd));
  });

  it('reassembles byte-identically from header + record slices + CRC', () => {
    const parts = [
      bytes.subarray(0, s.dataStart),
      ...s.records.map((r) => bytes.subarray(r.offset, r.offset + r.length)),
      bytes.subarray(s.dataEnd, s.dataEnd + 2),
    ];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let pos = 0;
    for (const p of parts) {
      out.set(p, pos);
      pos += p.length;
    }
    expect(out).toEqual(bytes);
  });

  it('recomputeCrc leaves the file unchanged (except filling a 0x0000 header CRC)', () => {
    const out = recomputeCrc(bytes);
    if (truth.options.headerCrc === 'zero') {
      // Only the header CRC and, since it covers the header, the file CRC may change.
      expect(out.subarray(0, 12)).toEqual(bytes.subarray(0, 12));
      expect(out.subarray(14, s.dataEnd)).toEqual(bytes.subarray(14, s.dataEnd));
      const after = parseStructure(out);
      expect(after.headerCrcStatus).toBe('valid');
      expect(after.fileCrc?.valid).toBe(true);
    } else {
      expect(out).toEqual(bytes);
    }
  });

  it('does not modify its input', () => {
    const copy = bytes.slice();
    parseStructure(bytes);
    expect(bytes).toEqual(copy);
  });

  it('finds every message the generator wrote', () => {
    const counts: Record<number, number> = {};
    for (const m of data) counts[m.globalMesgNum] = (counts[m.globalMesgNum] ?? 0) + 1;
    expect(counts).toEqual(truth.dataMessageCounts);
    expect(defs).toHaveLength(truth.definitionCount);
    expect(data.filter((m) => m.compressedTimestamp)).toHaveLength(truth.compressedCount);
    expect(defs.every((d) => d.endianness === truth.options.endianness)).toBe(true);
  });

  it('places developer fields exactly where the generator put them', () => {
    const withDev = new Set(defs.filter((d) => d.hasDeveloperFields).map((d) => d.globalMesgNum));
    expect([...withDev].sort((a, b) => a - b)).toEqual(
      truth.options.developerFields ? [MesgNum.session, MesgNum.record] : [],
    );
  });

  it('reads summary timestamps that match the ground truth', () => {
    expect(read(MesgNum.lap, 253)).toEqual(truth.laps.map((l) => l.writtenTimestamp));
    expect(read(MesgNum.lap, 2)).toEqual(truth.laps.map((l) => l.startTime));
    expect(read(MesgNum.lap, 7)).toEqual(truth.laps.map((l) => l.totalElapsedTimeMs));
    expect(read(MesgNum.session, 253)).toEqual(truth.sessions.map((x) => x.writtenTimestamp));
    expect(read(MesgNum.session, 2)).toEqual(truth.sessions.map((x) => x.startTime));
    expect(read(MesgNum.session, 7)).toEqual(truth.sessions.map((x) => x.totalElapsedTimeMs));
    expect(read(MesgNum.activity, 253)).toEqual([truth.activity.writtenTimestamp]);
    expect(read(MesgNum.activity, 5)).toEqual([truth.activity.writtenLocalTimestamp]);
    expect(read(MesgNum.timeInZone, 253)).toEqual(truth.timeInZone.map((z) => z.writtenTimestamp));
    expect(read(MesgNum.timeInZone, 0)).toEqual(truth.timeInZone.map((z) => z.referenceMesg));
    expect(read(MesgNum.timeInZone, 1)).toEqual(truth.timeInZone.map((z) => z.referenceIndex));
  });
});

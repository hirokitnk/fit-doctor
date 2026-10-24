import { BaseType, FitBuilder, MesgNum, PRESET_NAMES, preset } from '@fit-doctor/fixtures';
import { sdkCanDecode, sdkCheck } from '@fit-doctor/fixtures/sdk';
import { describe, expect, it } from 'vitest';
import { diagnose } from '../src/diagnose.js';
import { FitStructureError } from '../src/repair.js';
import { stripMessages } from '../src/strip.js';
import { parseStructure } from '../src/structure.js';
import { recordSlices } from './helpers/records.js';

const MODE_B: number[] = [MesgNum.gpsMetadata, MesgNum.unknown233, MesgNum.unknown534];

const without = (messages: Record<string, unknown>, ...keys: string[]) =>
  Object.fromEntries(Object.entries(messages).filter(([k]) => !keys.includes(k)));

describe('stripMessages: round trip when nothing matches', () => {
  it.each(PRESET_NAMES)('%s with an absent message number is byte-identical', (name) => {
    const { bytes } = preset(name);
    for (const nums of [[], [9999], [MesgNum.unknown233 + 1]]) {
      const r = stripMessages(bytes, nums);
      expect(r.changed).toBe(false);
      expect(r.bytes).toEqual(bytes);
      expect(r.report).toEqual({ removed: [], bytesRemoved: 0, compressedTimestampsChanged: 0 });
    }
  });
});

describe.each(PRESET_NAMES.filter((n) => preset(n).truth.dataMessageCounts[MesgNum.gpsMetadata]))(
  'stripMessages: %s',
  (name) => {
    const { bytes, truth } = preset(name);
    const before = parseStructure(bytes);

    it.each<[number[]]>([[[MesgNum.gpsMetadata]], [[MesgNum.unknown233, MesgNum.unknown534]], [MODE_B]])(
      'removes %j and nothing else',
      (nums) => {
        const r = stripMessages(bytes, nums);
        const after = parseStructure(r.bytes);
        expect(r.changed).toBe(true);
        expect(after.errors).toEqual([]);
        expect(after.fileCrc?.valid).toBe(true);
        expect(after.header?.dataSize).toBe(r.bytes.length - after.dataStart - 2);
        expect(after.headerCrcStatus).toBe(before.headerCrcStatus === 'absent' ? 'absent' : 'valid');

        // Every surviving record is byte-identical and in the original order.
        const kept = before.records.filter((rec) => !nums.includes(rec.globalMesgNum));
        expect(recordSlices(r.bytes, after)).toEqual(kept.map((k) => Array.from(bytes.subarray(k.offset, k.offset + k.length))));
        expect(after.records.some((rec) => nums.includes(rec.globalMesgNum))).toBe(false);

        // Report matches what was there.
        const expected = nums
          .filter((n) => truth.dataMessageCounts[n])
          .map((n) => ({ globalMesgNum: n, dataMessages: truth.dataMessageCounts[n] }));
        expect(r.report.removed.map((x) => ({ globalMesgNum: x.globalMesgNum, dataMessages: x.dataMessages }))).toEqual(expected);
        const removedBytes = r.report.removed.reduce((n, x) => n + x.bytes, 0);
        expect(r.report.bytesRemoved).toBe(removedBytes);
        expect(r.bytes.length).toBe(bytes.length - removedBytes);
        expect(r.report.compressedTimestampsChanged).toBe(0);

        // Diagnosis of the rest is unchanged.
        const d0 = diagnose(bytes);
        const d1 = diagnose(r.bytes);
        expect(d1.messages).toEqual(d0.messages.filter((m) => !nums.includes(m.globalMesgNum)));
        expect(d1.timestamps).toEqual(d0.timestamps);

        const sdk = sdkCheck(r.bytes);
        expect(sdk.integrity).toBe(true);
        if (sdkCanDecode(truth.compressedCount)) {
          expect(sdk.errors).toEqual([]);
          // The SDK already ignores 233/534, so only gps_metadata can disappear from its view.
          expect(sdk.messages).toEqual(
            without(sdkCheck(bytes).messages, ...(nums.includes(MesgNum.gpsMetadata) ? ['gpsMetadataMesgs'] : [])),
          );
        }

        const again = stripMessages(r.bytes, nums);
        expect(again.changed).toBe(false);
        expect(again.bytes).toEqual(r.bytes);
      },
    );
  },
);

describe('stripMessages: local slot handling', () => {
  const one = (num: number) => ({ globalMesgNum: num, fields: [{ num: 0, baseType: BaseType.uint8 }] });

  it('removes data governed by the removed definition, up to the slot being redefined', () => {
    const bytes = new FitBuilder()
      .define(0, one(160))
      .data(0, { 0: 1 })
      .define(1, one(20))
      .data(1, { 0: 2 })
      .data(0, { 0: 3 }) // still gps_metadata
      .define(0, one(21)) // slot 0 now event
      .data(0, { 0: 4 })
      .data(1, { 0: 5 })
      .define(0, one(160)) // and gps_metadata again
      .data(0, { 0: 6 })
      .build();
    const r = stripMessages(bytes, [160]);
    const s = parseStructure(r.bytes);
    expect(s.errors).toEqual([]);
    expect(s.records.map((x) => [x.kind, x.localType, x.globalMesgNum])).toEqual([
      ['definition', 1, 20],
      ['data', 1, 20],
      ['definition', 0, 21],
      ['data', 0, 21],
      ['data', 1, 20],
    ]);
    expect(r.report.removed).toEqual([
      { globalMesgNum: 160, name: 'gps_metadata', definitions: 2, dataMessages: 3, bytes: 2 * 9 + 3 * 2 },
    ]);
    expect(sdkCheck(r.bytes).errors).toEqual([]);
  });

  it('reports compressed messages that lose their reference timestamp', () => {
    const T0 = 1_000_000_000;
    const ts = (num: number) => ({ globalMesgNum: num, fields: [{ num: 253, baseType: BaseType.uint32 }] });
    const bytes = new FitBuilder()
      .define(0, ts(MesgNum.record))
      .data(0, { 253: T0 })
      .define(1, ts(MesgNum.gpsMetadata))
      .data(1, { 253: T0 + 40 })
      .define(2, { globalMesgNum: MesgNum.record, fields: [{ num: 3, baseType: BaseType.uint8 }] })
      .compressed(2, (T0 + 45) & 0x1f, { 3: 1 }) // T0+45 via gps_metadata; T0+13 without it
      .compressed(2, (T0 + 46) & 0x1f, { 3: 2 })
      .build();
    const r = stripMessages(bytes, [MesgNum.gpsMetadata]);
    expect(r.report.compressedTimestampsChanged).toBe(2);
    expect(stripMessages(bytes, [MesgNum.unknown233]).report.compressedTimestampsChanged).toBe(0);
  });

  it('preserves trailing bytes and refuses broken files', () => {
    const { bytes } = preset('modeB');
    const r = stripMessages(Uint8Array.from([...bytes, 7, 7]), MODE_B);
    expect(Array.from(r.bytes.subarray(-2))).toEqual([7, 7]);
    expect(diagnose(r.bytes).crc.file).toBe('valid');
    expect(() => stripMessages(bytes.subarray(0, 200), MODE_B)).toThrow(FitStructureError);
  });

  it('does not mutate its input', () => {
    const { bytes } = preset('everything');
    const copy = bytes.slice();
    stripMessages(bytes, MODE_B);
    expect(bytes).toEqual(copy);
  });
});

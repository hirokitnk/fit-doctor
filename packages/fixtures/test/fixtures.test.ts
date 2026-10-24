import { CrcCalculator } from '@garmin/fitsdk';
import { describe, expect, it } from 'vitest';
import {
  BaseType,
  FitBuilder,
  MesgNum,
  PRESET_NAMES,
  PRESET_OPTIONS,
  type GeneratedFit,
  crc16Bitwise,
  generateActivity,
  preset,
  prng,
} from '../src/index.js';
import { sdkCanDecode, sdkCheck } from '../src/sdk.js';

type Mesg = Record<string, unknown>;

describe('crc16Bitwise', () => {
  it('matches the CRC-16/ARC check value and the Garmin SDK', () => {
    expect(crc16Bitwise(Array.from('123456789', (c) => c.charCodeAt(0)))).toBe(0xbb3d);
    const rand = prng(9);
    const buf = Uint8Array.from({ length: 500 }, () => Math.floor(rand() * 256));
    expect(crc16Bitwise(buf)).toBe(CrcCalculator.calculateCRC(buf, 0, buf.length));
  });
});

describe('FitBuilder', () => {
  const record = { globalMesgNum: 20, fields: [{ num: 253, baseType: BaseType.uint32 }] };

  it('writes invalid sentinels for omitted fields', () => {
    const bytes = new FitBuilder()
      .define(0, {
        globalMesgNum: 20,
        fields: [
          { num: 253, baseType: BaseType.uint32 },
          { num: 3, baseType: BaseType.uint8 },
          { num: 9, baseType: BaseType.uint16z },
        ],
      })
      .data(0, {})
      .build();
    // header(14) + definition(1+5+9) + data header(1)
    expect(Array.from(bytes.subarray(30, 37))).toEqual([0xff, 0xff, 0xff, 0xff, 0xff, 0x00, 0x00]);
  });

  it('rejects data that does not match the active definition', () => {
    expect(() => new FitBuilder().data(0, {})).toThrow(/no definition/);
    expect(() => new FitBuilder().define(0, record).data(0, { 7: 1 })).toThrow(/not in the definition/);
    expect(() => new FitBuilder().define(0, record).data(0, { 253: 2 ** 32 })).toThrow(/does not fit/);
    expect(() => new FitBuilder().define(4, record).compressed(4, 0, {})).toThrow(/compressed local type/);
  });
});

describe('generateActivity', () => {
  it('is deterministic for a given seed', () => {
    expect(generateActivity({ seed: 5 }).bytes).toEqual(generateActivity({ seed: 5 }).bytes);
    expect(generateActivity({ seed: 5 }).bytes).not.toEqual(generateActivity({ seed: 6 }).bytes);
  });

  it('produces correct end times and no inverted intervals when not collapsed', () => {
    const { truth } = preset('normal');
    expect(truth.endBeforeStartCount).toBe(0);
    for (const x of [...truth.laps, ...truth.sessions]) {
      expect(x.endTime).toBe(x.startTime + Math.round(x.totalElapsedTimeMs / 1000));
      expect(x.writtenTimestamp).toBe(x.endTime);
    }
    expect(truth.activity.writtenTimestamp).toBe(truth.endTime);
    expect(truth.activity.localTimestamp - truth.activity.endTime).toBe(9 * 3600);
  });

  it('collapses every summary timestamp to the activity start in mode A', () => {
    const { truth } = preset('collapsedTimestamps');
    const all = [...truth.laps, ...truth.sessions, truth.activity, ...truth.timeInZone];
    expect(all.every((x) => x.writtenTimestamp === truth.startTime)).toBe(true);
    // The first lap and first session start at the activity start, so they are not "end < start".
    expect(truth.endBeforeStartCount).toBe(truth.laps.length - 1 + truth.sessions.length - 1);
    expect(truth.activity.writtenLocalTimestamp - truth.activity.writtenTimestamp).toBe(truth.utcOffsetSeconds);
  });

  it('reproduces the shape of the real triathlon case', () => {
    const { truth } = preset('triathlonCollapsed');
    expect(truth.laps).toHaveLength(86);
    expect(truth.sessions).toHaveLength(5);
    expect(truth.timeInZone).toHaveLength(91);
    expect(truth.dataMessageCounts[MesgNum.lap]).toBe(86);
    expect(truth.dataMessageCounts[MesgNum.timeInZone]).toBe(91);
    expect(truth.laps.filter((l) => l.writtenTimestamp < l.startTime)).toHaveLength(85);
  });

  it('keeps session and lap timelines consistent', () => {
    const { truth } = preset('triathlonCollapsed');
    for (const s of truth.sessions) {
      const laps = truth.laps.slice(s.firstLapIndex, s.firstLapIndex + s.numLaps);
      expect(laps[0]?.startTime).toBe(s.startTime);
      expect(s.endTime).toBe(laps[laps.length - 1]!.endTime);
    }
    expect(truth.activity.endTime).toBe(Math.max(...truth.sessions.map((s) => s.endTime)));
  });

  it('uses compressed headers where the time delta allows', () => {
    const { truth } = preset('compressedTimestamps');
    expect(truth.compressedCount).toBeGreaterThan(truth.recordTimestamps.length / 2);
    expect(truth.compressedCount).toBeLessThan(truth.recordTimestamps.length);
  });

  it('rejects invalid local type budgets', () => {
    expect(() => generateActivity({ localTypes: 0 })).toThrow();
    expect(() => generateActivity({ localTypes: 1, compressedTimestamps: true })).toThrow();
  });
});

function expectSdkMatchesTruth({ bytes, truth }: GeneratedFit): void {
  const sdk = sdkCheck(bytes);
  expect(sdk.errors).toEqual([]);
  const m = sdk.messages;
  const laps = m.lapMesgs as Mesg[];
  const sessions = m.sessionMesgs as Mesg[];
  const activity = (m.activityMesgs as Mesg[])[0]!;
  const tiz = m.timeInZoneMesgs as Mesg[];

  expect(laps.map((l) => [l.messageIndex, l.timestamp, l.startTime, l.totalElapsedTime])).toEqual(
    truth.laps.map((l) => [l.messageIndex, l.writtenTimestamp, l.startTime, l.totalElapsedTimeMs / 1000]),
  );
  expect(sessions.map((s) => [s.messageIndex, s.timestamp, s.startTime, s.firstLapIndex, s.numLaps, s.sport])).toEqual(
    truth.sessions.map((s) => [s.messageIndex, s.writtenTimestamp, s.startTime, s.firstLapIndex, s.numLaps, s.sport]),
  );
  expect([activity.timestamp, activity.localTimestamp, activity.numSessions]).toEqual([
    truth.activity.writtenTimestamp,
    truth.activity.writtenLocalTimestamp,
    truth.activity.numSessions,
  ]);
  expect(tiz.map((z) => [z.timestamp, z.referenceMesg, z.referenceIndex])).toEqual(
    truth.timeInZone.map((z) => [z.writtenTimestamp, z.referenceMesg, z.referenceIndex]),
  );
  expect((m.recordMesgs as Mesg[]).map((r) => r.timestamp)).toEqual(truth.recordTimestamps);
  expect(m.gpsMetadataMesgs?.length ?? 0).toBe(truth.dataMessageCounts[MesgNum.gpsMetadata] ?? 0);

  if (truth.options.developerFields) {
    expect(m.fieldDescriptionMesgs).toHaveLength(3);
    const rec = (m.recordMesgs as Mesg[])[0]!;
    expect(Object.keys(rec.developerFields as object)).toEqual(['0', '1']);
    expect(Object.keys((sessions[0]!.developerFields as object) ?? {})).toEqual(['2']);
  }
}

describe.each(PRESET_NAMES)('preset %s', (name) => {
  const fit = preset(name);

  it('passes the Garmin SDK CRC integrity check', () => {
    const sdk = sdkCheck(fit.bytes);
    expect(sdk.isFIT).toBe(true);
    expect(sdk.integrity).toBe(true);
  });

  it.runIf(sdkCanDecode(fit.truth.compressedCount))('decodes with 0 SDK errors and matches its ground truth', () => {
    expectSdkMatchesTruth(fit);
  });

  it.runIf(!sdkCanDecode(fit.truth.compressedCount))('is undecodable by the SDK only because of compressed headers', () => {
    expect(String(sdkCheck(fit.bytes).errors[0])).toMatch(/compressed timestamp/);
  });

  it('honours its header options', () => {
    const opts = PRESET_OPTIONS[name] as { headerSize?: number; headerCrc?: string };
    expect(fit.bytes[0]).toBe(opts.headerSize ?? 14);
    if (opts.headerCrc === 'zero') expect([fit.bytes[12], fit.bytes[13]]).toEqual([0, 0]);
  });
});

describe('compressed fixtures decode correctly once compressed records are expanded', () => {
  // Cross-check the compressed fixtures' non-compressed content against an equivalent
  // uncompressed file: same seed and options except compression must yield the same truth.
  it.each(['compressedTimestamps', 'everything'] as const)('%s', (name) => {
    const compressed = preset(name);
    const plain = generateActivity({ ...PRESET_OPTIONS[name], compressedTimestamps: false } as never);
    expect(plain.truth.compressedCount).toBe(0);
    expect(compressed.truth.laps).toEqual(plain.truth.laps);
    expect(compressed.truth.sessions).toEqual(plain.truth.sessions);
    expect(compressed.truth.recordTimestamps).toEqual(plain.truth.recordTimestamps);
    expectSdkMatchesTruth(plain);
  });
});

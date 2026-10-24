import { BaseType, FitBuilder, MesgNum, PRESET_NAMES, generateActivity, preset } from '@fit-doctor/fixtures';
import { describe, expect, it } from 'vitest';
import { diagnose } from '../src/diagnose.js';
import { knownMesgNums, mesgName } from '../src/profile.js';
import { classifyInterval } from '../src/summary.js';
import { Profile } from '@garmin/fitsdk';

const u16 = BaseType.uint16;
const u32 = BaseType.uint32;
const T0 = 1_000_000_000;

const LAP = {
  globalMesgNum: MesgNum.lap,
  fields: [
    { num: 254, baseType: u16 },
    { num: 253, baseType: u32 },
    { num: 2, baseType: u32 },
    { num: 7, baseType: u32 },
  ],
};
const TIZ = {
  globalMesgNum: MesgNum.timeInZone,
  fields: [
    { num: 253, baseType: u32 },
    { num: 0, baseType: u16 },
    { num: 1, baseType: u16 },
  ],
};

describe('profile table', () => {
  it('matches the message numbers of the installed Garmin SDK profile', () => {
    const sdk = Object.values(Profile.MesgNum as Record<string, number>).sort((a, b) => a - b);
    expect(knownMesgNums()).toEqual(sdk);
    expect(mesgName(19)).toBe('lap');
    expect(mesgName(233)).toBeNull();
    expect(mesgName(534)).toBeNull();
  });
});

describe('classifyInterval', () => {
  it.each([
    [T0 + 60, T0, 60_000, 'ok'],
    [T0 + 61, T0, 60_000, 'ok'], // within 1 s tolerance
    [T0 + 62, T0, 60_000, 'end-mismatch'],
    [T0 - 1, T0, 60_000, 'end-before-start'],
    [T0, T0, 60_000, 'zero-duration'],
    [T0, T0, 1, 'zero-duration'], // any positive elapsed counts
    [T0, T0, 0, 'ok'],
    [T0, T0, null, 'ok'], // elapsed unknown: cannot call it zero-duration
    [T0 - 5, T0, null, 'end-before-start'],
    [null, T0, 60_000, 'missing'],
    [T0, null, 60_000, 'missing'],
  ] as const)('timestamp=%s start=%s elapsed=%s → %s', (ts, start, elapsed, expected) => {
    expect(classifyInterval(ts, start, elapsed)).toBe(expected);
  });
});

describe('diagnose: presets', () => {
  it.each(PRESET_NAMES)('%s: never reports structural or CRC problems', (name) => {
    const d = diagnose(preset(name).bytes);
    expect(d.header.valid).toBe(true);
    expect(d.structure.ok).toBe(true);
    expect(d.crc.file).toBe('valid');
    expect(d.findings.filter((f) => ['structure-error', 'header-crc-invalid', 'file-crc-invalid'].includes(f.code))).toEqual([]);
    expect(d.header.expectedFileSize).toBe(d.fileSize);
  });

  it.each(PRESET_NAMES)('%s: message counts match the generator', (name) => {
    const { bytes, truth } = preset(name);
    const d = diagnose(bytes);
    const counts = Object.fromEntries(d.messages.filter((m) => m.dataCount > 0).map((m) => [m.globalMesgNum, m.dataCount]));
    expect(counts).toEqual(truth.dataMessageCounts);
    expect(d.structure.definitionCount).toBe(truth.definitionCount);
    expect(d.structure.compressedTimestampCount).toBe(truth.compressedCount);
    expect(d.messages.reduce((n, m) => n + m.dataBytes + m.definitionBytes, 0)).toBe(d.header.dataSize);
  });

  it('reports a clean file as clean', () => {
    const { bytes, truth } = preset('normal');
    const d = diagnose(bytes);
    expect(d.findings).toEqual([]);
    expect(d.timestamps.collapsedSuspected).toBe(false);
    expect(d.timestamps.laps).toEqual({ count: 3, ok: 3, endBeforeStart: 0, zeroDuration: 0, endMismatch: 0, missing: 0 });
    expect(d.timestamps.sessions.ok).toBe(1);
    expect(d.timestamps.timeInZones).toMatchObject({ count: 4, ok: 4, unresolved: 0 });
    expect(d.timestamps.activity).toEqual({ count: 1, endBeforeSessionsEnd: 0, missing: 0, utcOffsetSeconds: 9 * 3600 });
    expect(d.unknownMesgNums).toEqual([]);
    expect(d.developerFields.present).toBe(false);
    expect(d.duration.fromElapsedTimeSeconds).toBe(truth.endTime - truth.startTime);
    expect(d.duration.fromSummaryTimestampsSeconds).toBe(truth.endTime - truth.startTime);
    expect(d.duration.estimatedSeconds).toBe(truth.endTime - truth.startTime);
    const records = truth.recordTimestamps;
    expect(d.duration.fromRecordsSeconds).toBe(records[records.length - 1]! - records[0]!);
  });

  it('detects mode A in the triathlon-shaped file, separating zero-duration from end-before-start', () => {
    const { bytes, truth } = preset('triathlonCollapsed');
    const d = diagnose(bytes);
    const t = d.timestamps;
    // First lap / first session start at the activity start, so they collapse to zero duration.
    expect(t.laps).toMatchObject({ count: 86, endBeforeStart: 85, zeroDuration: 1, ok: 0 });
    expect(t.sessions).toMatchObject({ count: 5, endBeforeStart: 4, zeroDuration: 1, ok: 0 });
    // time_in_zone is judged against the start of the lap/session it references.
    expect(t.timeInZones).toMatchObject({ count: 91, endBeforeStart: 89, zeroDuration: 2, unresolved: 0 });
    expect(t.endBeforeStart).toBe(85 + 4 + 89);
    expect(t.zeroDuration).toBe(1 + 1 + 2);
    expect(t.activity).toEqual({ count: 1, endBeforeSessionsEnd: 1, missing: 0, utcOffsetSeconds: 9 * 3600 });
    expect(t.collapsedSuspected).toBe(true);
    expect(truth.endBeforeStartCount).toBe(t.laps.endBeforeStart + t.sessions.endBeforeStart);

    expect(d.duration.fromSummaryTimestampsSeconds).toBe(0);
    expect(d.duration.estimatedSeconds).toBe(truth.endTime - truth.startTime);
    expect(d.duration.fromRecordsSeconds).toBeGreaterThan(0);

    expect(d.findings.map((f) => [f.code, f.severity])).toEqual([
      ['summary-end-before-start', 'error'],
      ['activity-before-sessions-end', 'error'],
      ['summary-zero-duration', 'warning'],
      ['gps-metadata-present', 'info'],
      ['unknown-messages-present', 'info'],
      ['developer-fields-present', 'info'],
    ]);
    expect(d.findings[0]?.params).toEqual({ count: 178, laps: 85, sessions: 4, timeInZones: 89 });
    expect(d.findings[2]?.params).toEqual({ count: 4, laps: 1, sessions: 1, timeInZones: 2 });
  });

  it('gives the same timestamp verdicts for big-endian, 12-byte and compressed variants', () => {
    const reference = diagnose(generateActivity({ collapsedTimestamps: true }).bytes).timestamps;
    for (const variant of [{ endianness: 'big' }, { headerSize: 12 }, { compressedTimestamps: true }] as const) {
      expect(diagnose(generateActivity({ collapsedTimestamps: true, ...variant }).bytes).timestamps).toEqual(reference);
    }
  });

  it('reports mode-B payloads', () => {
    const { bytes, truth } = preset('modeB');
    const d = diagnose(bytes);
    const records = truth.dataMessageCounts[MesgNum.record]!;
    const sessions = truth.dataMessageCounts[MesgNum.session]!;
    expect(d.unknownMesgNums).toEqual([233, 534]);
    expect(d.messages.find((m) => m.globalMesgNum === 233)).toMatchObject({ name: null, known: false, dataCount: records });
    expect(d.messages.find((m) => m.globalMesgNum === 160)).toMatchObject({ name: 'gps_metadata', known: true });
    expect(d.developerFields).toEqual({
      present: true,
      developerDataIdCount: 1,
      fieldDescriptionCount: 3,
      definitionsWithDeveloperFields: 2,
      dataMessagesWithDeveloperFields: records + sessions,
      developerDataBytes: records * 3 + sessions * 4,
    });
    expect(d.findings.map((f) => f.code)).toEqual([
      'gps-metadata-present',
      'unknown-messages-present',
      'developer-fields-present',
    ]);
    expect(d.findings[1]?.params).toEqual({ count: 2 * records, mesgNums: [233, 534] });
  });

  it('ignores compressed records for the record-based duration', () => {
    const { bytes, truth } = preset('compressedTimestamps');
    const d = diagnose(bytes);
    expect(d.duration.fromRecordsSeconds).not.toBeNull();
    expect(d.duration.fromRecordsSeconds!).toBeLessThanOrEqual(truth.endTime - truth.startTime);
  });
});

describe('diagnose: edge cases', () => {
  it('treats invalid sentinels as missing, not as data', () => {
    const bytes = new FitBuilder()
      .define(0, LAP)
      .data(0, { 254: 0, 253: T0 - 100, 7: 60_000 }) // start_time omitted → 0xFFFFFFFF
      .data(0, { 254: 1, 2: T0, 7: 60_000 }) // timestamp omitted
      .data(0, { 254: 2, 253: T0, 2: T0 }) // elapsed invalid: not zero-duration
      .build();
    expect(diagnose(bytes).timestamps.laps).toEqual({
      count: 3,
      ok: 1,
      endBeforeStart: 0,
      zeroDuration: 0,
      endMismatch: 0,
      missing: 2,
    });
  });

  it('treats a timestamp field of unexpected size as missing', () => {
    const bytes = new FitBuilder()
      .define(0, {
        globalMesgNum: MesgNum.lap,
        fields: [
          { num: 253, baseType: u16 },
          { num: 2, baseType: u32 },
        ],
      })
      .data(0, { 253: 5, 2: T0 })
      .build();
    expect(diagnose(bytes).timestamps.laps.missing).toBe(1);
  });

  it('reports end-mismatch beyond 1 s', () => {
    const bytes = new FitBuilder().define(0, LAP).data(0, { 254: 0, 253: T0 + 70, 2: T0, 7: 60_000 }).build();
    const d = diagnose(bytes);
    expect(d.timestamps.laps.endMismatch).toBe(1);
    expect(d.findings.map((f) => f.code)).toEqual(['summary-end-mismatch']);
  });

  it('resolves time_in_zone by message_index, masking flag bits', () => {
    const bytes = new FitBuilder()
      .define(0, LAP)
      // Written out of order: message_index 1 comes first.
      .data(0, { 254: 1, 253: T0 + 200, 2: T0 + 100, 7: 100_000 })
      .data(0, { 254: 0x8000 | 0, 253: T0 + 100, 2: T0, 7: 100_000 })
      .define(1, TIZ)
      .data(1, { 253: T0 + 50, 0: MesgNum.lap, 1: 1 }) // lap 1 starts at T0+100 → end-before-start
      .data(1, { 253: T0 + 50, 0: MesgNum.lap, 1: 0x8000 | 0 }) // lap 0 starts at T0 → mismatch, not before start
      .data(1, { 253: T0, 0: MesgNum.lap, 1: 7 }) // no such lap
      .data(1, { 253: T0, 0: MesgNum.record, 1: 0 }) // not a lap/session
      .data(1, { 253: T0, 1: 0 }) // reference_mesg invalid
      .build();
    expect(diagnose(bytes).timestamps.timeInZones).toEqual({
      count: 5,
      ok: 0,
      endBeforeStart: 1,
      zeroDuration: 0,
      endMismatch: 1,
      missing: 0,
      unresolved: 3,
    });
  });

  it('falls back to file order when laps carry no message_index', () => {
    const noIndexLap = { ...LAP, fields: LAP.fields.filter((f) => f.num !== 254) };
    const bytes = new FitBuilder()
      .define(0, noIndexLap)
      .data(0, { 253: T0 + 60, 2: T0, 7: 60_000 })
      .data(0, { 253: T0 + 120, 2: T0 + 60, 7: 60_000 })
      .define(1, TIZ)
      .data(1, { 253: T0 + 120, 0: MesgNum.lap, 1: 1 })
      .data(1, { 253: T0 + 60, 0: MesgNum.lap, 1: 1 })
      .build();
    expect(diagnose(bytes).timestamps.timeInZones).toMatchObject({ ok: 1, zeroDuration: 1, unresolved: 0 });
  });

  it('flags manufacturer-range message numbers as unknown', () => {
    const bytes = new FitBuilder()
      .define(0, { globalMesgNum: 0xff10, fields: [{ num: 0, baseType: BaseType.uint8 }] })
      .data(0, { 0: 1 })
      .define(1, { globalMesgNum: 1000, fields: [{ num: 0, baseType: BaseType.uint8 }] }) // definition only
      .build();
    const d = diagnose(bytes);
    expect(d.unknownMesgNums).toEqual([1000, 0xff10]);
    expect(d.findings[0]?.params).toEqual({ count: 1, mesgNums: [1000, 0xff10] });
  });

  it('reports header, CRC and structure problems', () => {
    const good = preset('normal').bytes;

    const badHeaderCrc = good.slice();
    badHeaderCrc[12] ^= 0xff;
    expect(diagnose(badHeaderCrc).findings.map((f) => f.code)).toContain('header-crc-invalid');

    const badFileCrc = good.slice();
    badFileCrc[badFileCrc.length - 1] ^= 0xff;
    expect(diagnose(badFileCrc).crc.file).toBe('invalid');

    const truncated = diagnose(good.subarray(0, good.length - 40));
    expect(truncated.crc.file).toBe('unavailable');
    expect(truncated.structure.ok).toBe(false);
    expect(truncated.findings.filter((f) => f.code === 'structure-error').map((f) => f.params.reason)).toEqual([
      'data-truncated',
      'record-truncated',
    ]);

    const notFit = diagnose(Uint8Array.from([14, 0x20, 0, 0, 0, 0, 0, 0, 0x41, 0x42, 0x43, 0x44, 0, 0]));
    expect(notFit.header.valid).toBe(false);
    expect(notFit.findings).toEqual([{ code: 'header-invalid', severity: 'error', params: { reason: 'bad-signature' } }]);
    expect(notFit.messages).toEqual([]);
    expect(notFit.duration.estimatedSeconds).toBeNull();

    const trailing = diagnose(Uint8Array.from([...good, 0, 0, 0]));
    expect(trailing.findings).toEqual([{ code: 'trailing-bytes', severity: 'warning', params: { count: 3 } }]);
  });

  it('is read-only and never throws', () => {
    const { bytes } = preset('everything');
    const copy = bytes.slice();
    diagnose(bytes);
    expect(bytes).toEqual(copy);
    for (let cut = 0; cut < bytes.length; cut += 97) {
      expect(() => diagnose(bytes.subarray(0, cut))).not.toThrow();
    }
    const corrupted = bytes.slice();
    for (let i = 14; i < corrupted.length; i += 13) corrupted[i] ^= 0x5a;
    expect(() => diagnose(corrupted)).not.toThrow();
  });
});

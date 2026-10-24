import { BaseType, FitBuilder, MesgNum, PRESET_NAMES, PRESET_OPTIONS, generateActivity, preset } from '@fit-doctor/fixtures';
import { sdkCanDecode, sdkCheck } from '@fit-doctor/fixtures/sdk';
import { describe, expect, it } from 'vitest';
import { diagnose } from '../src/diagnose.js';
import { FitStructureError } from '../src/repair.js';
import { repairTimestamps } from '../src/repair-timestamps.js';
import { diffOffsets } from './helpers/diff.js';

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
const SESSION = { ...LAP, globalMesgNum: MesgNum.session };
const ACTIVITY = {
  globalMesgNum: MesgNum.activity,
  fields: [
    { num: 253, baseType: u32 },
    { num: 5, baseType: u32 },
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

const COLLAPSED = PRESET_NAMES.filter((n) => (PRESET_OPTIONS[n] as { collapsedTimestamps?: boolean }).collapsedTimestamps);
const CLEAN = PRESET_NAMES.filter((n) => !COLLAPSED.includes(n));

describe('repairTimestamps: round trip on files with nothing to repair', () => {
  it.each(CLEAN)('%s is returned byte-identical', (name) => {
    const { bytes } = preset(name);
    const result = repairTimestamps(bytes);
    expect(result.changed).toBe(false);
    expect(result.bytes).toEqual(bytes);
    expect(result.bytes).not.toBe(bytes);
    expect(result.report.changes).toEqual([]);
  });
});

describe.each(COLLAPSED)('repairTimestamps: %s', (name) => {
  const { bytes, truth } = preset(name);
  const result = repairTimestamps(bytes);

  it('produces exactly the file the generator writes without the collapse', () => {
    const clean = generateActivity({ ...(PRESET_OPTIONS[name] as object), collapsedTimestamps: false });
    expect(result.changed).toBe(true);
    expect(result.bytes).toEqual(clean.bytes);
  });

  it('only touches the reported fields and the CRCs', () => {
    const allowed = new Set<number>();
    for (const c of result.report.changes) for (let i = 0; i < 4; i++) allowed.add(c.offset + i);
    const headerSize = bytes[0]!;
    if (headerSize === 14) allowed.add(12).add(13);
    allowed.add(bytes.length - 2).add(bytes.length - 1);
    expect(diffOffsets(bytes, result.bytes).every((o) => allowed.has(o))).toBe(true);
    expect(bytes.length).toBe(result.bytes.length);
  });

  it('reports the two failure kinds separately', () => {
    const r = result.report;
    const laps = truth.laps.length;
    const sessions = truth.sessions.length;
    expect(r.laps).toEqual({ endBeforeStart: laps - 1, zeroDuration: 1, unrepairable: 0 });
    expect(r.sessions).toEqual({ endBeforeStart: sessions - 1, zeroDuration: 1, unrepairable: 0 });
    // time_in_zone for a session starts with that session's first lap: the first lap and the
    // first session both start at the activity start.
    expect(r.timeInZones).toEqual({
      endBeforeStart: laps - 1 + sessions - 1,
      zeroDuration: 2,
      unrepairable: 0,
      unresolved: 0,
    });
    expect(r.activity).toEqual({ repaired: 1, localTimestampRepaired: 1, skipped: 0 });
    expect(r.totals).toEqual({
      endBeforeStart: r.laps.endBeforeStart + r.sessions.endBeforeStart + r.timeInZones.endBeforeStart,
      zeroDuration: 4,
    });
    expect(r.changes).toHaveLength(r.totals.endBeforeStart + r.totals.zeroDuration + 2);
    // Matches what diagnose() reported beforehand.
    const before = diagnose(bytes).timestamps;
    expect(r.totals).toEqual({ endBeforeStart: before.endBeforeStart, zeroDuration: before.zeroDuration });
  });

  it('leaves nothing for diagnose() to flag and is idempotent', () => {
    const after = diagnose(result.bytes);
    expect(after.timestamps.collapsedSuspected).toBe(false);
    expect(after.timestamps.endBeforeStart + after.timestamps.zeroDuration).toBe(0);
    expect(after.duration.fromSummaryTimestampsSeconds).toBe(truth.endTime - truth.startTime);
    expect(after.timestamps.activity.utcOffsetSeconds).toBe(truth.utcOffsetSeconds);
    const again = repairTimestamps(result.bytes);
    expect(again.changed).toBe(false);
    expect(again.bytes).toEqual(result.bytes);
  });

  it('passes the Garmin SDK checks and decodes to the true end times', () => {
    const sdk = sdkCheck(result.bytes);
    expect(sdk.integrity).toBe(true);
    if (!sdkCanDecode(truth.compressedCount)) return;
    expect(sdk.errors).toEqual([]);
    const m = sdk.messages;
    expect(m.lapMesgs?.map((l) => l.timestamp)).toEqual(truth.laps.map((l) => l.endTime));
    expect(m.sessionMesgs?.map((s) => s.timestamp)).toEqual(truth.sessions.map((s) => s.endTime));
    expect(m.timeInZoneMesgs?.map((z) => z.timestamp)).toEqual(truth.timeInZone.map((z) => z.endTime));
    expect(m.activityMesgs?.[0]).toMatchObject({
      timestamp: truth.activity.endTime,
      localTimestamp: truth.activity.localTimestamp,
    });
  });

  it('does not shift compressed timestamps in these fixtures', () => {
    expect(result.report.compressedTimestampsChanged).toBe(0);
  });
});

describe('repairTimestamps: edge cases', () => {
  it('repairs only the broken intervals and leaves correct ones alone', () => {
    const bytes = new FitBuilder()
      .define(0, LAP)
      .data(0, { 254: 0, 253: T0 + 60, 2: T0, 7: 60_000 }) // correct
      .data(0, { 254: 1, 253: T0, 2: T0 + 60, 7: 59_600 }) // end < start → T0+120
      .data(0, { 254: 2, 253: T0 + 120, 2: T0 + 120, 7: 30_499 }) // zero duration → T0+150
      .data(0, { 254: 3, 253: T0 + 150, 2: T0 + 150, 7: 400 }) // rounds to 0 s: already right
      .data(0, { 254: 4, 253: T0 + 150, 2: T0 + 150, 7: 0 }) // genuinely zero
      .data(0, { 254: 5, 253: T0 + 200, 2: T0 + 150, 7: 10_000 }) // mismatch, but not collapsed
      .data(0, { 254: 6, 253: T0, 2: T0 + 300 }) // end < start, elapsed invalid
      .build();
    const r = repairTimestamps(bytes);
    expect(r.report.laps).toEqual({ endBeforeStart: 1, zeroDuration: 1, unrepairable: 1 });
    expect(r.report.changes.map((c) => [c.recordIndex, c.before, c.after])).toEqual([
      [2, T0, T0 + 120],
      [3, T0 + 120, T0 + 150],
    ]);
  });

  it('writes big-endian fields in big-endian order', () => {
    const b = new FitBuilder().define(0, LAP, 'big').data(0, { 254: 0, 253: T0, 2: T0 + 10, 7: 5_000 }).build();
    const r = repairTimestamps(b);
    const c = r.report.changes[0]!;
    const v = T0 + 15;
    expect(Array.from(r.bytes.subarray(c.offset, c.offset + 4))).toEqual([v >>> 24, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);
  });

  it('sets activity to the latest session end and keeps the UTC offset', () => {
    const offset = -5 * 3600;
    const bytes = new FitBuilder()
      .define(0, SESSION)
      .data(0, { 254: 0, 253: T0, 2: T0, 7: 100_000 }) // → T0+100
      .data(0, { 254: 1, 253: T0 + 400, 2: T0 + 100, 7: 300_000 }) // correct, T0+400
      .define(1, ACTIVITY)
      .data(1, { 253: T0, 5: T0 + offset })
      .data(1, { 253: T0 + 400, 5: T0 + 400 + offset }) // already right
      .data(1, { 253: T0 }) // local_timestamp invalid
      .build();
    const r = repairTimestamps(bytes);
    expect(r.report.activity).toEqual({ repaired: 2, localTimestampRepaired: 1, skipped: 0 });
    const d = diagnose(r.bytes);
    expect(d.timestamps.activity.endBeforeSessionsEnd).toBe(0);
    expect(d.timestamps.activity.utcOffsetSeconds).toBe(offset);
    const local = r.report.changes.find((c) => c.fieldNum === 5)!;
    expect(local.after - T0 - 400).toBe(offset);
  });

  it('skips activity when no session end is known', () => {
    const bytes = new FitBuilder().define(0, ACTIVITY).data(0, { 253: T0, 5: T0 }).build();
    const r = repairTimestamps(bytes);
    expect(r.changed).toBe(false);
    expect(r.report.activity.skipped).toBe(1);
  });

  it('repairs time_in_zone from the referenced interval and skips what cannot be resolved', () => {
    const bytes = new FitBuilder()
      .define(0, LAP)
      .data(0, { 254: 0, 253: T0, 2: T0, 7: 60_000 }) // zero duration → T0+60
      .data(0, { 254: 1, 253: T0, 2: T0 + 60 }) // elapsed invalid: unrepairable
      .define(1, TIZ)
      .data(1, { 253: T0, 0: MesgNum.lap, 1: 0 }) // → T0+60 (zero duration)
      .data(1, { 253: T0, 0: MesgNum.lap, 1: 1 }) // reference unrepairable
      .data(1, { 253: T0, 0: MesgNum.lap, 1: 9 }) // unresolved
      .data(1, { 253: T0, 0: MesgNum.session, 1: 0 }) // no sessions: unresolved
      .build();
    const r = repairTimestamps(bytes);
    expect(r.report.laps).toEqual({ endBeforeStart: 0, zeroDuration: 1, unrepairable: 1 });
    expect(r.report.timeInZones).toEqual({ endBeforeStart: 0, zeroDuration: 1, unrepairable: 1, unresolved: 2 });
    expect(r.report.changes.filter((c) => c.globalMesgNum === MesgNum.timeInZone).map((c) => c.after)).toEqual([T0 + 60]);
  });

  it('reports compressed messages whose decoded time moves because their reference was repaired', () => {
    const record = { globalMesgNum: MesgNum.record, fields: [{ num: 3, baseType: BaseType.uint8 }] };
    const bytes = new FitBuilder()
      .define(0, LAP)
      .data(0, { 254: 0, 253: T0, 2: T0, 7: 20_000 }) // collapsed; repaired to T0+20
      .define(1, record)
      // 40 s after the lap's true end: decodes to T0+8 against the collapsed reference, T0+40 after.
      .compressed(1, (T0 + 40) & 0x1f, { 3: 100 })
      .build();
    const r = repairTimestamps(bytes);
    expect(r.report.compressedTimestampsChanged).toBe(1);
    expect(sdkCheck(r.bytes).integrity).toBe(true);
  });

  it('preserves bytes after the file CRC', () => {
    const { bytes } = preset('collapsedTimestamps');
    const chained = Uint8Array.from([...bytes, 1, 2, 3]);
    const r = repairTimestamps(chained);
    expect(Array.from(r.bytes.subarray(-3))).toEqual([1, 2, 3]);
    expect(diagnose(r.bytes).crc.file).toBe('valid');
  });

  it('refuses structurally broken files and never mutates its input', () => {
    const { bytes } = preset('collapsedTimestamps');
    expect(() => repairTimestamps(bytes.subarray(0, bytes.length - 30))).toThrow(FitStructureError);
    const copy = bytes.slice();
    repairTimestamps(bytes);
    expect(bytes).toEqual(copy);
  });
});

import { writeUnsigned } from './bytes.js';
import { recomputeCrc } from './header.js';
import { type RepairResult, compressedTimestamps, countCompressedShifts, parseForRepair } from './repair.js';
import { type DataMessage, type DefinitionMessage, fieldOffset } from './structure.js';
import {
  END_MISMATCH_TOLERANCE_SECONDS,
  FIELD_LOCAL_TIMESTAMP,
  FIELD_TIMESTAMP,
  type IntervalSummary,
  classifyInterval,
  collectSummaries,
} from './summary.js';

export interface IntervalRepairCounts {
  /** Repaired because timestamp < start_time. */
  endBeforeStart: number;
  /** Repaired because timestamp == start_time while total_elapsed_time > 0. */
  zeroDuration: number;
  /** Broken but left untouched because the correct end time cannot be determined. */
  unrepairable: number;
}

export interface FieldChange {
  recordIndex: number;
  globalMesgNum: number;
  fieldNum: number;
  /** Absolute offset of the field's first byte. */
  offset: number;
  before: number;
  after: number;
}

export interface TimestampRepairReport {
  laps: IntervalRepairCounts;
  sessions: IntervalRepairCounts;
  /** Judged against the referenced lap/session; repaired to that interval's end time. */
  timeInZones: IntervalRepairCounts & { unresolved: number };
  activity: {
    repaired: number;
    /** local_timestamp values shifted to keep the original UTC offset. */
    localTimestampRepaired: number;
    /** Activity messages left alone because no session end time was available. */
    skipped: number;
  };
  /** Sums over laps, sessions and time_in_zone. */
  totals: { endBeforeStart: number; zeroDuration: number };
  changes: FieldChange[];
  /**
   * Compressed-timestamp messages that a decoder would now place at a different time, because
   * a repaired timestamp is their reference.
   */
  compressedTimestampsChanged: number;
}

/**
 * Restores lap/session/activity/time_in_zone end times (field 253) that were collapsed to a
 * start time. Only overwrites existing 4-byte fields in place; values that are already plausible
 * are never touched.
 *
 * Repaired when timestamp < start_time, or timestamp == start_time with total_elapsed_time > 0:
 * - lap / session: start_time + round(total_elapsed_time / 1000)
 * - activity: latest session end; local_timestamp keeps its original offset from timestamp
 * - time_in_zone: end time of the referenced lap/session (left alone if unresolved)
 */
export function repairTimestamps(bytes: Uint8Array): RepairResult<TimestampRepairReport> {
  const structure = parseForRepair(bytes);
  const summaries = collectSummaries(bytes, structure);
  const out = bytes.slice();
  const changes: FieldChange[] = [];

  const write = (message: DataMessage, definition: DefinitionMessage, fieldNum: number, before: number, after: number) => {
    const offset = fieldOffset(definition, message, fieldNum) as number;
    writeUnsigned(out, offset, 4, definition.endianness, after);
    changes.push({ recordIndex: message.index, globalMesgNum: message.globalMesgNum, fieldNum, offset, before, after });
  };

  // End time of each lap/session after repair, or null when it is still not trustworthy.
  const finalEnd = new Map<IntervalSummary, number | null>();
  const isPlausibleEnd = (end: number | null, item: IntervalSummary) => {
    const state = classifyInterval(end, item.startTime, item.totalElapsedTimeMs);
    // Without a start_time there is no evidence against a stored end time.
    if (state === 'missing') return end !== null;
    return state === 'ok' || state === 'end-mismatch';
  };

  const repairIntervals = (items: IntervalSummary[]): IntervalRepairCounts => {
    const counts: IntervalRepairCounts = { endBeforeStart: 0, zeroDuration: 0, unrepairable: 0 };
    for (const item of items) {
      let end = item.timestamp;
      const state = classifyInterval(item.timestamp, item.startTime, item.totalElapsedTimeMs);
      if (state === 'end-before-start' || state === 'zero-duration') {
        const target = item.computedEndTime;
        if (target === null) {
          counts.unrepairable++;
        } else if (target !== item.timestamp) {
          write(item.message, item.definition, FIELD_TIMESTAMP, item.timestamp as number, target);
          counts[state === 'end-before-start' ? 'endBeforeStart' : 'zeroDuration']++;
          end = target;
        }
        // target === timestamp: elapsed rounds to 0 s, so the stored value is already right.
      }
      finalEnd.set(item, isPlausibleEnd(end, item) ? end : null);
    }
    return counts;
  };

  const laps = repairIntervals(summaries.laps);
  const sessions = repairIntervals(summaries.sessions);

  const sessionEnds = summaries.sessions.flatMap((s) => {
    const end = finalEnd.get(s);
    return end == null ? [] : [end];
  });
  const latestSessionEnd = sessionEnds.length > 0 ? Math.max(...sessionEnds) : null;
  const activity = { repaired: 0, localTimestampRepaired: 0, skipped: 0 };
  for (const a of summaries.activities) {
    if (a.timestamp === null || latestSessionEnd === null) {
      if (a.timestamp !== null) activity.skipped++;
      continue;
    }
    if (a.timestamp >= latestSessionEnd - END_MISMATCH_TOLERANCE_SECONDS) continue;
    write(a.message, a.definition, FIELD_TIMESTAMP, a.timestamp, latestSessionEnd);
    activity.repaired++;
    if (a.localTimestamp !== null) {
      const local = latestSessionEnd + (a.localTimestamp - a.timestamp);
      if (local >= 0 && local < 0xffffffff) {
        write(a.message, a.definition, FIELD_LOCAL_TIMESTAMP, a.localTimestamp, local);
        activity.localTimestampRepaired++;
      }
    }
  }

  const timeInZones = { endBeforeStart: 0, zeroDuration: 0, unrepairable: 0, unresolved: 0 };
  for (const z of summaries.timeInZones) {
    const ref = z.reference;
    if (ref === null) {
      timeInZones.unresolved++;
      continue;
    }
    const state = classifyInterval(z.timestamp, ref.startTime, ref.totalElapsedTimeMs);
    if (state !== 'end-before-start' && state !== 'zero-duration') continue;
    const target = finalEnd.get(ref) ?? null;
    if (target === null) {
      timeInZones.unrepairable++;
    } else if (target !== z.timestamp) {
      write(z.message, z.definition, FIELD_TIMESTAMP, z.timestamp as number, target);
      timeInZones[state === 'end-before-start' ? 'endBeforeStart' : 'zeroDuration']++;
    }
  }

  const report: TimestampRepairReport = {
    laps,
    sessions,
    timeInZones,
    activity,
    totals: {
      endBeforeStart: laps.endBeforeStart + sessions.endBeforeStart + timeInZones.endBeforeStart,
      zeroDuration: laps.zeroDuration + sessions.zeroDuration + timeInZones.zeroDuration,
    },
    changes,
    compressedTimestampsChanged: 0,
  };

  if (changes.length === 0) return { bytes: bytes.slice(), changed: false, report };

  const repaired = recomputeCrc(out);
  // The layout is unchanged, so the original structure describes the output too.
  const before = compressedTimestamps(bytes, structure);
  report.compressedTimestampsChanged = countCompressedShifts(
    before,
    before.map(() => true),
    compressedTimestamps(repaired, structure),
  );
  return { bytes: repaired, changed: true, report };
}

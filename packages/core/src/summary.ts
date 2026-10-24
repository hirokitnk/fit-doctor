import { type DataMessage, type DefinitionMessage, type FitStructure } from './structure.js';
import { readValidUnsigned } from './values.js';

export const MESG_SESSION = 18;
export const MESG_LAP = 19;
export const MESG_RECORD = 20;
export const MESG_ACTIVITY = 34;
export const MESG_GPS_METADATA = 160;
export const MESG_FIELD_DESCRIPTION = 206;
export const MESG_DEVELOPER_DATA_ID = 207;
export const MESG_TIME_IN_ZONE = 216;

export const FIELD_TIMESTAMP = 253;
export const FIELD_MESSAGE_INDEX = 254;
/** lap / session */
export const FIELD_START_TIME = 2;
export const FIELD_TOTAL_ELAPSED_TIME = 7;
/** activity */
export const FIELD_LOCAL_TIMESTAMP = 5;
/** time_in_zone */
export const FIELD_REFERENCE_MESG = 0;
export const FIELD_REFERENCE_INDEX = 1;

/** message_index carries a "selected" flag in its top bits; the index is the low 12 bits. */
const MESSAGE_INDEX_MASK = 0x0fff;

interface Located {
  message: DataMessage;
  definition: DefinitionMessage;
}

/** A lap or session. All values are null when absent or invalid. */
export interface IntervalSummary extends Located {
  /** Position among messages of the same type, in file order. */
  ordinal: number;
  messageIndex: number | null;
  timestamp: number | null;
  startTime: number | null;
  /** Milliseconds (scale 1000). */
  totalElapsedTimeMs: number | null;
  /** startTime + round(totalElapsedTimeMs / 1000), or null if either is missing. */
  computedEndTime: number | null;
}

export interface ActivitySummary extends Located {
  timestamp: number | null;
  localTimestamp: number | null;
}

export interface TimeInZoneSummary extends Located {
  timestamp: number | null;
  referenceMesg: number | null;
  referenceIndex: number | null;
  /** The lap or session this message refers to, or null if it cannot be resolved. */
  reference: IntervalSummary | null;
}

export interface Summaries {
  laps: IntervalSummary[];
  sessions: IntervalSummary[];
  activities: ActivitySummary[];
  timeInZones: TimeInZoneSummary[];
}

/** Reads the timestamp-related fields of all summary messages. Read-only. */
export function collectSummaries(bytes: Uint8Array, structure: FitStructure): Summaries {
  const laps: IntervalSummary[] = [];
  const sessions: IntervalSummary[] = [];
  const activities: ActivitySummary[] = [];
  const tizMessages: Located[] = [];

  for (const record of structure.records) {
    if (record.kind !== 'data') continue;
    const definition = structure.records[record.definitionIndex] as DefinitionMessage;
    const located = { message: record, definition };
    switch (record.globalMesgNum) {
      case MESG_LAP:
        laps.push(readInterval(bytes, located, laps.length));
        break;
      case MESG_SESSION:
        sessions.push(readInterval(bytes, located, sessions.length));
        break;
      case MESG_ACTIVITY:
        activities.push({
          ...located,
          timestamp: readValidUnsigned(bytes, definition, record, FIELD_TIMESTAMP, 4),
          localTimestamp: readValidUnsigned(bytes, definition, record, FIELD_LOCAL_TIMESTAMP, 4),
        });
        break;
      case MESG_TIME_IN_ZONE:
        tizMessages.push(located);
        break;
    }
  }

  const lapLookup = indexLookup(laps);
  const sessionLookup = indexLookup(sessions);
  const timeInZones = tizMessages.map(({ message, definition }): TimeInZoneSummary => {
    const referenceMesg = readValidUnsigned(bytes, definition, message, FIELD_REFERENCE_MESG, 2);
    const referenceIndex = readValidUnsigned(bytes, definition, message, FIELD_REFERENCE_INDEX, 2);
    const lookup = referenceMesg === MESG_LAP ? lapLookup : referenceMesg === MESG_SESSION ? sessionLookup : null;
    const reference = lookup !== null && referenceIndex !== null ? lookup(referenceIndex & MESSAGE_INDEX_MASK) : null;
    return {
      message,
      definition,
      timestamp: readValidUnsigned(bytes, definition, message, FIELD_TIMESTAMP, 4),
      referenceMesg,
      referenceIndex,
      reference,
    };
  });

  return { laps, sessions, activities, timeInZones };
}

function readInterval(bytes: Uint8Array, { message, definition }: Located, ordinal: number): IntervalSummary {
  const rawIndex = readValidUnsigned(bytes, definition, message, FIELD_MESSAGE_INDEX, 2);
  const startTime = readValidUnsigned(bytes, definition, message, FIELD_START_TIME, 4);
  const totalElapsedTimeMs = readValidUnsigned(bytes, definition, message, FIELD_TOTAL_ELAPSED_TIME, 4);
  return {
    message,
    definition,
    ordinal,
    messageIndex: rawIndex === null ? null : rawIndex & MESSAGE_INDEX_MASK,
    timestamp: readValidUnsigned(bytes, definition, message, FIELD_TIMESTAMP, 4),
    startTime,
    totalElapsedTimeMs,
    computedEndTime:
      startTime !== null && totalElapsedTimeMs !== null ? startTime + Math.round(totalElapsedTimeMs / 1000) : null,
  };
}

/**
 * Resolves a reference_index to a lap/session. Matches message_index first; falls back to file
 * order only when no message of that type carries a message_index.
 */
function indexLookup(items: IntervalSummary[]): (index: number) => IntervalSummary | null {
  const byIndex = new Map<number, IntervalSummary>();
  for (const item of items) {
    if (item.messageIndex !== null && !byIndex.has(item.messageIndex)) byIndex.set(item.messageIndex, item);
  }
  if (byIndex.size === 0) return (index) => items[index] ?? null;
  return (index) => byIndex.get(index) ?? null;
}

export type IntervalState =
  /** timestamp is at or after start_time and agrees with start_time + elapsed (±1 s). */
  | 'ok'
  /** timestamp < start_time. */
  | 'end-before-start'
  /** timestamp == start_time although total_elapsed_time > 0. */
  | 'zero-duration'
  /** timestamp > start_time but differs from start_time + elapsed by more than 1 s. */
  | 'end-mismatch'
  /** timestamp or start_time is absent/invalid. */
  | 'missing';

/** Tolerance for `end-mismatch`, in seconds. */
export const END_MISMATCH_TOLERANCE_SECONDS = 1;

export function classifyInterval(
  timestamp: number | null,
  startTime: number | null,
  totalElapsedTimeMs: number | null,
): IntervalState {
  if (timestamp === null || startTime === null) return 'missing';
  if (timestamp < startTime) return 'end-before-start';
  if (timestamp === startTime && totalElapsedTimeMs !== null && totalElapsedTimeMs > 0) return 'zero-duration';
  if (totalElapsedTimeMs !== null) {
    const expected = startTime + Math.round(totalElapsedTimeMs / 1000);
    if (Math.abs(timestamp - expected) > END_MISMATCH_TOLERANCE_SECONDS) return 'end-mismatch';
  }
  return 'ok';
}

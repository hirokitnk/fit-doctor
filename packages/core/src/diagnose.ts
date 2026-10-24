import type { HeaderCrcStatus } from './header.js';
import { isKnownMesgNum, mesgName } from './profile.js';
import { type DefinitionMessage, type FitStructure, type ParseError, parseStructure } from './structure.js';
import {
  END_MISMATCH_TOLERANCE_SECONDS,
  FIELD_TIMESTAMP,
  type IntervalState,
  type IntervalSummary,
  MESG_DEVELOPER_DATA_ID,
  MESG_FIELD_DESCRIPTION,
  MESG_GPS_METADATA,
  MESG_RECORD,
  type Summaries,
  classifyInterval,
  collectSummaries,
} from './summary.js';
import { readValidUnsigned } from './values.js';

export interface MessageStats {
  globalMesgNum: number;
  /** Public profile name, or null for message numbers the profile does not define. */
  name: string | null;
  known: boolean;
  dataCount: number;
  definitionCount: number;
  /** Total bytes of this type's data messages, including record headers. */
  dataBytes: number;
  /** Total bytes of this type's definition messages. */
  definitionBytes: number;
}

export interface IntervalStats {
  count: number;
  ok: number;
  /** timestamp < start_time */
  endBeforeStart: number;
  /** timestamp == start_time while total_elapsed_time > 0 */
  zeroDuration: number;
  /** timestamp > start_time but more than 1 s away from start_time + total_elapsed_time */
  endMismatch: number;
  /** timestamp or start_time absent/invalid */
  missing: number;
}

export interface TimeInZoneStats extends IntervalStats {
  /** reference_mesg/reference_index do not resolve to a lap or session; not classified. */
  unresolved: number;
}

export interface ActivityStats {
  count: number;
  /** activity timestamp earlier than the latest session end (start_time + total_elapsed_time). */
  endBeforeSessionsEnd: number;
  /** timestamp absent/invalid. */
  missing: number;
  /** local_timestamp - timestamp of the first activity message, when both are valid. */
  utcOffsetSeconds: number | null;
}

export interface TimestampStats {
  laps: IntervalStats;
  sessions: IntervalStats;
  timeInZones: TimeInZoneStats;
  activity: ActivityStats;
  /** Sum of endBeforeStart over laps, sessions and time_in_zone. */
  endBeforeStart: number;
  /** Sum of zeroDuration over laps, sessions and time_in_zone. */
  zeroDuration: number;
  /** True when any summary looks like failure mode A (end time collapsed to a start time). */
  collapsedSuspected: boolean;
}

export interface DurationEstimate {
  /** Span from the earliest session start to the latest start_time + total_elapsed_time (laps if no sessions). */
  fromElapsedTimeSeconds: number | null;
  /** Span between the first and last record timestamps (normal headers only). */
  fromRecordsSeconds: number | null;
  /** Latest session timestamp minus earliest session start: what consumers compute; negative in mode A. */
  fromSummaryTimestampsSeconds: number | null;
  /** Best estimate: fromElapsedTimeSeconds, else fromRecordsSeconds. */
  estimatedSeconds: number | null;
}

export interface DeveloperFieldStats {
  present: boolean;
  developerDataIdCount: number;
  fieldDescriptionCount: number;
  definitionsWithDeveloperFields: number;
  dataMessagesWithDeveloperFields: number;
  /** Developer field bytes across all data messages. */
  developerDataBytes: number;
}

export type Severity = 'error' | 'warning' | 'info';

export type FindingCode =
  | 'header-invalid'
  | 'structure-error'
  | 'header-crc-invalid'
  | 'file-crc-invalid'
  | 'trailing-bytes'
  | 'summary-end-before-start'
  | 'summary-zero-duration'
  | 'summary-end-mismatch'
  | 'activity-before-sessions-end'
  | 'gps-metadata-present'
  | 'unknown-messages-present'
  | 'developer-fields-present';

/** Machine-readable finding; UIs localize from `code` and `params`. */
export interface Finding {
  code: FindingCode;
  severity: Severity;
  params: Record<string, number | number[] | string>;
}

export interface Diagnosis {
  fileSize: number;
  header: {
    valid: boolean;
    headerSize: number | null;
    protocolVersion: number | null;
    profileVersion: number | null;
    dataSize: number | null;
    /** headerSize + dataSize + 2 */
    expectedFileSize: number | null;
  };
  crc: {
    header: HeaderCrcStatus | null;
    file: 'valid' | 'invalid' | 'unavailable';
    storedFileCrc: number | null;
    computedFileCrc: number | null;
  };
  structure: {
    ok: boolean;
    errors: ParseError[];
    recordCount: number;
    definitionCount: number;
    dataMessageCount: number;
    compressedTimestampCount: number;
    trailingBytes: number;
  };
  /** Sorted by global message number. */
  messages: MessageStats[];
  /** Global message numbers with data or definitions that the public profile does not define. */
  unknownMesgNums: number[];
  developerFields: DeveloperFieldStats;
  timestamps: TimestampStats;
  duration: DurationEstimate;
  /** Sorted by severity (errors first). */
  findings: Finding[];
}

/** Read-only report on a FIT file. Never throws for malformed input. */
export function diagnose(bytes: Uint8Array): Diagnosis {
  const structure = parseStructure(bytes);
  const header = structure.header;
  const summaries = collectSummaries(bytes, structure);
  const messages = messageStats(structure);
  const timestamps = timestampStats(summaries);

  const diagnosis: Diagnosis = {
    fileSize: bytes.length,
    header: {
      valid: header !== null,
      headerSize: header?.headerSize ?? null,
      protocolVersion: header?.protocolVersion ?? null,
      profileVersion: header?.profileVersion ?? null,
      dataSize: header?.dataSize ?? null,
      expectedFileSize: header === null ? null : header.headerSize + header.dataSize + 2,
    },
    crc: {
      header: structure.headerCrcStatus,
      file: structure.fileCrc === null ? 'unavailable' : structure.fileCrc.valid ? 'valid' : 'invalid',
      storedFileCrc: structure.fileCrc?.stored ?? null,
      computedFileCrc: structure.fileCrc?.computed ?? null,
    },
    structure: {
      ok: structure.errors.length === 0,
      errors: structure.errors,
      recordCount: structure.records.length,
      definitionCount: structure.records.filter((r) => r.kind === 'definition').length,
      dataMessageCount: structure.records.filter((r) => r.kind === 'data').length,
      compressedTimestampCount: structure.records.filter((r) => r.kind === 'data' && r.compressedTimestamp).length,
      trailingBytes: structure.trailingBytes,
    },
    messages,
    unknownMesgNums: messages.filter((m) => !m.known).map((m) => m.globalMesgNum),
    developerFields: developerFieldStats(structure, messages),
    timestamps,
    duration: durationEstimate(bytes, structure, summaries),
    findings: [],
  };
  diagnosis.findings = findings(diagnosis);
  return diagnosis;
}

function messageStats(structure: FitStructure): MessageStats[] {
  const stats = new Map<number, MessageStats>();
  for (const r of structure.records) {
    let s = stats.get(r.globalMesgNum);
    if (s === undefined) {
      s = {
        globalMesgNum: r.globalMesgNum,
        name: mesgName(r.globalMesgNum),
        known: isKnownMesgNum(r.globalMesgNum),
        dataCount: 0,
        definitionCount: 0,
        dataBytes: 0,
        definitionBytes: 0,
      };
      stats.set(r.globalMesgNum, s);
    }
    if (r.kind === 'data') {
      s.dataCount++;
      s.dataBytes += r.length;
    } else {
      s.definitionCount++;
      s.definitionBytes += r.length;
    }
  }
  return [...stats.values()].sort((a, b) => a.globalMesgNum - b.globalMesgNum);
}

function developerFieldStats(structure: FitStructure, messages: MessageStats[]): DeveloperFieldStats {
  let definitionsWithDeveloperFields = 0;
  let dataMessagesWithDeveloperFields = 0;
  let developerDataBytes = 0;
  for (const r of structure.records) {
    if (r.kind === 'definition') {
      if (r.hasDeveloperFields) definitionsWithDeveloperFields++;
      continue;
    }
    const def = structure.records[r.definitionIndex] as DefinitionMessage;
    if (def.developerFieldsSize > 0) {
      dataMessagesWithDeveloperFields++;
      developerDataBytes += def.developerFieldsSize;
    }
  }
  const count = (num: number) => messages.find((m) => m.globalMesgNum === num)?.dataCount ?? 0;
  const developerDataIdCount = count(MESG_DEVELOPER_DATA_ID);
  const fieldDescriptionCount = count(MESG_FIELD_DESCRIPTION);
  return {
    present: definitionsWithDeveloperFields > 0 || developerDataIdCount > 0 || fieldDescriptionCount > 0,
    developerDataIdCount,
    fieldDescriptionCount,
    definitionsWithDeveloperFields,
    dataMessagesWithDeveloperFields,
    developerDataBytes,
  };
}

function emptyIntervalStats(): IntervalStats {
  return { count: 0, ok: 0, endBeforeStart: 0, zeroDuration: 0, endMismatch: 0, missing: 0 };
}

function tally(stats: IntervalStats, state: IntervalState): void {
  stats.count++;
  switch (state) {
    case 'ok':
      stats.ok++;
      break;
    case 'end-before-start':
      stats.endBeforeStart++;
      break;
    case 'zero-duration':
      stats.zeroDuration++;
      break;
    case 'end-mismatch':
      stats.endMismatch++;
      break;
    case 'missing':
      stats.missing++;
      break;
  }
}

function intervalStats(items: IntervalSummary[]): IntervalStats {
  const stats = emptyIntervalStats();
  for (const i of items) tally(stats, classifyInterval(i.timestamp, i.startTime, i.totalElapsedTimeMs));
  return stats;
}

function timestampStats(summaries: Summaries): TimestampStats {
  const laps = intervalStats(summaries.laps);
  const sessions = intervalStats(summaries.sessions);

  const timeInZones: TimeInZoneStats = { ...emptyIntervalStats(), unresolved: 0 };
  for (const z of summaries.timeInZones) {
    if (z.reference === null) {
      timeInZones.count++;
      timeInZones.unresolved++;
      continue;
    }
    tally(timeInZones, classifyInterval(z.timestamp, z.reference.startTime, z.reference.totalElapsedTimeMs));
  }

  const sessionEnds = summaries.sessions.flatMap((s) => (s.computedEndTime === null ? [] : [s.computedEndTime]));
  const latestSessionEnd = sessionEnds.length > 0 ? Math.max(...sessionEnds) : null;
  const first = summaries.activities[0];
  const activity: ActivityStats = {
    count: summaries.activities.length,
    endBeforeSessionsEnd: 0,
    missing: 0,
    utcOffsetSeconds:
      first?.timestamp != null && first.localTimestamp != null ? first.localTimestamp - first.timestamp : null,
  };
  for (const a of summaries.activities) {
    if (a.timestamp === null) activity.missing++;
    else if (latestSessionEnd !== null && a.timestamp < latestSessionEnd - END_MISMATCH_TOLERANCE_SECONDS) {
      activity.endBeforeSessionsEnd++;
    }
  }

  const endBeforeStart = laps.endBeforeStart + sessions.endBeforeStart + timeInZones.endBeforeStart;
  const zeroDuration = laps.zeroDuration + sessions.zeroDuration + timeInZones.zeroDuration;
  return {
    laps,
    sessions,
    timeInZones,
    activity,
    endBeforeStart,
    zeroDuration,
    collapsedSuspected: endBeforeStart > 0 || zeroDuration > 0 || activity.endBeforeSessionsEnd > 0,
  };
}

function durationEstimate(bytes: Uint8Array, structure: FitStructure, summaries: Summaries): DurationEstimate {
  const span = (starts: number[], ends: number[]) =>
    starts.length > 0 && ends.length > 0 ? Math.max(...ends) - Math.min(...starts) : null;
  const starts = (items: IntervalSummary[]) => items.flatMap((i) => (i.startTime === null ? [] : [i.startTime]));

  const intervals = summaries.sessions.length > 0 ? summaries.sessions : summaries.laps;
  const fromElapsedTimeSeconds = span(
    starts(intervals),
    intervals.flatMap((i) => (i.computedEndTime === null ? [] : [i.computedEndTime])),
  );
  const fromSummaryTimestampsSeconds = span(
    starts(summaries.sessions),
    summaries.sessions.flatMap((s) => (s.timestamp === null ? [] : [s.timestamp])),
  );

  let minRecord = Infinity;
  let maxRecord = -Infinity;
  for (const r of structure.records) {
    if (r.kind !== 'data' || r.globalMesgNum !== MESG_RECORD || r.compressedTimestamp) continue;
    const ts = readValidUnsigned(bytes, structure.records[r.definitionIndex] as DefinitionMessage, r, FIELD_TIMESTAMP, 4);
    if (ts === null) continue;
    if (ts < minRecord) minRecord = ts;
    if (ts > maxRecord) maxRecord = ts;
  }
  const fromRecordsSeconds = minRecord <= maxRecord ? maxRecord - minRecord : null;

  return {
    fromElapsedTimeSeconds,
    fromRecordsSeconds,
    fromSummaryTimestampsSeconds,
    estimatedSeconds: fromElapsedTimeSeconds ?? fromRecordsSeconds,
  };
}

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

function findings(d: Diagnosis): Finding[] {
  const out: Finding[] = [];
  const add = (code: FindingCode, severity: Severity, params: Finding['params'] = {}) =>
    out.push({ code, severity, params });

  if (!d.header.valid) add('header-invalid', 'error', { reason: d.structure.errors[0]?.code ?? 'unknown' });
  for (const e of d.structure.errors) {
    if (d.header.valid) add('structure-error', 'error', { reason: e.code, offset: e.offset });
  }
  if (d.crc.header === 'invalid') add('header-crc-invalid', 'error');
  if (d.crc.file === 'invalid') add('file-crc-invalid', 'error');
  if (d.structure.trailingBytes > 0) add('trailing-bytes', 'warning', { count: d.structure.trailingBytes });

  const t = d.timestamps;
  if (t.endBeforeStart > 0) {
    add('summary-end-before-start', 'error', {
      count: t.endBeforeStart,
      laps: t.laps.endBeforeStart,
      sessions: t.sessions.endBeforeStart,
      timeInZones: t.timeInZones.endBeforeStart,
    });
  }
  if (t.zeroDuration > 0) {
    add('summary-zero-duration', 'warning', {
      count: t.zeroDuration,
      laps: t.laps.zeroDuration,
      sessions: t.sessions.zeroDuration,
      timeInZones: t.timeInZones.zeroDuration,
    });
  }
  const mismatch = t.laps.endMismatch + t.sessions.endMismatch + t.timeInZones.endMismatch;
  if (mismatch > 0) add('summary-end-mismatch', 'warning', { count: mismatch });
  if (t.activity.endBeforeSessionsEnd > 0) {
    add('activity-before-sessions-end', 'error', { count: t.activity.endBeforeSessionsEnd });
  }

  const gps = d.messages.find((m) => m.globalMesgNum === MESG_GPS_METADATA);
  if (gps !== undefined && gps.dataCount > 0) add('gps-metadata-present', 'info', { count: gps.dataCount });
  if (d.unknownMesgNums.length > 0) {
    const count = d.messages.filter((m) => !m.known).reduce((n, m) => n + m.dataCount, 0);
    add('unknown-messages-present', 'info', { count, mesgNums: d.unknownMesgNums });
  }
  if (d.developerFields.present) {
    add('developer-fields-present', 'info', { count: d.developerFields.dataMessagesWithDeveloperFields });
  }

  return out.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

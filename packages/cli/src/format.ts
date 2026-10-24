import type {
  DeveloperStripReport,
  Diagnosis,
  Finding,
  IntervalStats,
  StripReport,
  TimestampRepairReport,
} from '@fit-doctor/core';

const n = (value: number) => value.toLocaleString('en-US');

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${n(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

/** h:mm:ss, with a leading minus for negative spans. */
export function formatDuration(seconds: number | null): string {
  if (seconds === null) return 'unknown';
  const sign = seconds < 0 ? '-' : '';
  const s = Math.abs(Math.round(seconds));
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${sign}${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/** UTC offset as ±hh:mm. */
export function formatUtcOffset(seconds: number): string {
  const sign = seconds < 0 ? '-' : '+';
  const m = Math.round(Math.abs(seconds) / 60);
  return `${sign}${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export function formatProtocolVersion(v: number): string {
  return `${v >> 4}.${v & 0x0f}`;
}

/** Profile versions above 2199 are encoded as major * 1000 + minor, older ones as major * 100 + minor. */
export function formatProfileVersion(v: number): string {
  const scale = v > 2199 ? 1000 : 100;
  return `${Math.floor(v / scale)}.${String(v % scale).padStart(scale === 1000 ? 3 : 2, '0')}`;
}

const SEVERITY_MARK = { error: '✗ error  ', warning: '! warning', info: 'i info   ' } as const;

export function describeFinding(f: Finding): string {
  const p = f.params;
  switch (f.code) {
    case 'header-invalid':
      return `Not a usable FIT header (${p.reason}).`;
    case 'structure-error':
      return `Record structure is broken at offset ${p.offset} (${p.reason}).`;
    case 'header-crc-invalid':
      return 'Header CRC does not match.';
    case 'file-crc-invalid':
      return 'File CRC does not match.';
    case 'trailing-bytes':
      return `${n(p.count as number)} bytes follow the file CRC (possibly a chained FIT file); they are not checked.`;
    case 'summary-end-before-start':
      return (
        `${n(p.count as number)} summary end times are earlier than their start ` +
        `(laps ${p.laps}, sessions ${p.sessions}, time_in_zone ${p.timeInZones}). Garmin Connect rejects negative durations.`
      );
    case 'summary-zero-duration':
      return (
        `${n(p.count as number)} summary end times equal their start despite a non-zero elapsed time ` +
        `(laps ${p.laps}, sessions ${p.sessions}, time_in_zone ${p.timeInZones}).`
      );
    case 'summary-end-mismatch':
      return `${n(p.count as number)} summary end times differ from start_time + total_elapsed_time by more than 1 s.`;
    case 'activity-before-sessions-end':
      return `The activity end time is earlier than the end of its last session.`;
    case 'gps-metadata-present':
      return `${n(p.count as number)} gps_metadata (160) messages. Removing them has helped some files import (mode B, unconfirmed).`;
    case 'unknown-messages-present':
      return `${n(p.count as number)} messages with numbers undefined in the public profile: ${(p.mesgNums as number[]).join(', ')}.`;
    case 'developer-fields-present':
      return `Connect IQ developer fields on ${n(p.count as number)} data messages.`;
  }
}

function table(rows: string[][], alignRight: boolean[]): string[] {
  const widths = rows[0]!.map((_, c) => Math.max(...rows.map((r) => r[c]!.length)));
  return rows.map((r) =>
    r
      .map((cell, c) => (alignRight[c] ? cell.padStart(widths[c]!) : cell.padEnd(widths[c]!)))
      .join('  ')
      .trimEnd(),
  );
}

function intervalRow(label: string, s: IntervalStats, unresolved?: number): string[] {
  return [
    label,
    n(s.count),
    n(s.ok),
    n(s.endBeforeStart),
    n(s.zeroDuration),
    n(s.endMismatch),
    n(s.missing),
    unresolved === undefined ? '-' : n(unresolved),
  ];
}

export function formatDiagnosis(file: string, d: Diagnosis): string {
  const out: string[] = [];
  out.push(`File       ${file} (${n(d.fileSize)} bytes)`);
  if (d.header.valid) {
    out.push(
      `Header     ${d.header.headerSize} bytes, protocol ${formatProtocolVersion(d.header.protocolVersion!)}, ` +
        `profile ${formatProfileVersion(d.header.profileVersion!)}, data ${n(d.header.dataSize!)} bytes`,
    );
  } else {
    out.push('Header     invalid');
  }
  out.push(`CRC        header ${d.crc.header ?? 'n/a'}, file ${d.crc.file}`);
  const st = d.structure;
  out.push(
    `Structure  ${st.ok ? 'OK' : 'BROKEN'}: ${n(st.recordCount)} records ` +
      `(${n(st.definitionCount)} definitions, ${n(st.dataMessageCount)} data, ${n(st.compressedTimestampCount)} compressed timestamp)`,
  );

  if (d.messages.length > 0) {
    out.push('', 'Messages');
    const rows = [['num', 'name', 'data', 'defs', 'size']];
    for (const m of d.messages) {
      rows.push([String(m.globalMesgNum), m.name ?? '(undefined)', n(m.dataCount), n(m.definitionCount), formatBytes(m.dataBytes + m.definitionBytes)]);
    }
    out.push(...table(rows, [true, false, true, true, true]).map((l) => `  ${l}`));
  }

  const t = d.timestamps;
  if (t.laps.count + t.sessions.count + t.timeInZones.count + t.activity.count > 0) {
    out.push('', 'Summary end times (field 253)');
    const rows = [
      ['', 'total', 'ok', 'end<start', 'zero-dur', 'mismatch', 'missing', 'unresolved'],
      intervalRow('lap', t.laps),
      intervalRow('session', t.sessions),
      intervalRow('time_in_zone', t.timeInZones, t.timeInZones.unresolved),
    ];
    out.push(...table(rows, [false, true, true, true, true, true, true, true]).map((l) => `  ${l}`));
    const a = t.activity;
    if (a.count > 0) {
      const offset = a.utcOffsetSeconds === null ? 'unknown' : formatUtcOffset(a.utcOffsetSeconds);
      out.push(`  activity: ${a.count} message(s), ${a.endBeforeSessionsEnd} before the last session end, UTC offset ${offset}`);
    }
  }

  out.push('', 'Duration');
  out.push(`  start_time + elapsed  ${formatDuration(d.duration.fromElapsedTimeSeconds)}`);
  out.push(`  records               ${formatDuration(d.duration.fromRecordsSeconds)}`);
  out.push(`  summary timestamps    ${formatDuration(d.duration.fromSummaryTimestampsSeconds)}  (what Garmin Connect computes)`);

  out.push('', 'Findings');
  if (d.findings.length === 0) out.push('  none');
  for (const f of d.findings) out.push(`  ${SEVERITY_MARK[f.severity]}  ${describeFinding(f)}`);
  return out.join('\n');
}

export function formatTimestampRepair(r: TimestampRepairReport): string[] {
  const pair = (c: { endBeforeStart: number; zeroDuration: number }) => `${c.endBeforeStart} + ${c.zeroDuration}`;
  const nothing = r.changes.length === 0;
  const out = nothing ? ['timestamps: nothing to repair'] : [
    `timestamps: repaired ${n(r.totals.endBeforeStart)} end<start and ${n(r.totals.zeroDuration)} zero-duration ` +
      `(laps ${pair(r.laps)}, sessions ${pair(r.sessions)}, time_in_zone ${pair(r.timeInZones)}); ` +
      `activity ${r.activity.repaired}, local_timestamp ${r.activity.localTimestampRepaired}`,
  ];
  const unrepairable = r.laps.unrepairable + r.sessions.unrepairable + r.timeInZones.unrepairable;
  if (unrepairable > 0) out.push(`  left unchanged: ${n(unrepairable)} without a usable total_elapsed_time`);
  if (r.timeInZones.unresolved > 0) out.push(`  left unchanged: ${n(r.timeInZones.unresolved)} time_in_zone with unresolvable reference`);
  if (r.activity.skipped > 0) out.push(`  left unchanged: ${r.activity.skipped} activity without any session end time`);
  return out;
}

export function formatStrip(label: string, r: StripReport | DeveloperStripReport): string[] {
  const parts = r.removed.map((x) => `${x.name ?? x.globalMesgNum} ×${n(x.dataMessages)}`);
  if ('definitionsModified' in r && (r.definitionsModified > 0 || r.dataMessagesTruncated > 0)) {
    parts.push(`fields cut from ${n(r.definitionsModified)} definitions / ${n(r.dataMessagesTruncated)} data messages`);
  }
  return [`${label}: ${parts.length === 0 ? 'nothing to remove' : `${parts.join(', ')} (${formatBytes(r.bytesRemoved)})`}`];
}

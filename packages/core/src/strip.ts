import { mesgName } from './profile.js';
import {
  type RepairResult,
  compressedTimestamps,
  countCompressedShifts,
  parseForRepair,
  rewriteRecords,
} from './repair.js';
import { type DefinitionMessage, type FitRecord, type FitStructure, parseStructure } from './structure.js';
import { MESG_DEVELOPER_DATA_ID, MESG_FIELD_DESCRIPTION } from './summary.js';

export interface RemovedMessages {
  globalMesgNum: number;
  name: string | null;
  definitions: number;
  dataMessages: number;
  bytes: number;
}

export interface StripReport {
  /** Per message number that was actually present, sorted by number. */
  removed: RemovedMessages[];
  bytesRemoved: number;
  /**
   * Retained compressed-timestamp messages that a decoder would now place at a different time,
   * because a removed message carried their reference timestamp.
   */
  compressedTimestampsChanged: number;
}

/**
 * Removes every definition and data message of the given global message numbers. Because a data
 * message belongs to the definition that last claimed its local slot, this removes exactly the
 * data governed by the removed definitions; other slots are never touched.
 */
export function stripMessages(bytes: Uint8Array, globalMesgNums: readonly number[]): RepairResult<StripReport> {
  const structure = parseForRepair(bytes);
  const targets = new Set(globalMesgNums);
  const removed = new Map<number, RemovedMessages>();
  const drop = (r: FitRecord) => targets.has(r.globalMesgNum);

  for (const r of structure.records) {
    if (!drop(r)) continue;
    tallyRemoved(removed, r);
  }
  const report: StripReport = { removed: sortRemoved(removed), bytesRemoved: 0, compressedTimestampsChanged: 0 };
  if (removed.size === 0) return { bytes: bytes.slice(), changed: false, report };

  const out = rewriteRecords(bytes, structure, (r) => (drop(r) ? null : undefined));
  report.bytesRemoved = bytes.length - out.length;
  report.compressedTimestampsChanged = compressedShifts(bytes, structure, out, (r) => !drop(r));
  return { bytes: out, changed: true, report };
}

export interface DeveloperStripReport {
  /** developer_data_id (207) and field_description (206) messages removed. */
  removed: RemovedMessages[];
  /** Definitions whose developer-data flag and developer field section were removed. */
  definitionsModified: number;
  /** Data messages whose trailing developer field bytes were cut. */
  dataMessagesTruncated: number;
  bytesRemoved: number;
  compressedTimestampsChanged: number;
}

/**
 * Removes all developer data: developer_data_id / field_description messages, the developer
 * field section of every definition (clearing record header bit 5), and the trailing developer
 * bytes of every data message. Regular field bytes are copied unchanged.
 */
export function stripDeveloperFields(bytes: Uint8Array): RepairResult<DeveloperStripReport> {
  const structure = parseForRepair(bytes);
  const isDevMessage = (r: FitRecord) =>
    r.globalMesgNum === MESG_DEVELOPER_DATA_ID || r.globalMesgNum === MESG_FIELD_DESCRIPTION;

  const removed = new Map<number, RemovedMessages>();
  let definitionsModified = 0;
  let dataMessagesTruncated = 0;
  for (const r of structure.records) {
    if (isDevMessage(r)) tallyRemoved(removed, r);
    else if (r.kind === 'definition' && r.hasDeveloperFields) definitionsModified++;
    else if (r.kind === 'data' && definitionOf(structure, r.definitionIndex).developerFieldsSize > 0) {
      dataMessagesTruncated++;
    }
  }
  const report: DeveloperStripReport = {
    removed: sortRemoved(removed),
    definitionsModified,
    dataMessagesTruncated,
    bytesRemoved: 0,
    compressedTimestampsChanged: 0,
  };
  if (removed.size === 0 && definitionsModified === 0 && dataMessagesTruncated === 0) {
    return { bytes: bytes.slice(), changed: false, report };
  }

  const out = rewriteRecords(bytes, structure, (r) => {
    if (isDevMessage(r)) return null;
    if (r.kind === 'definition') {
      if (!r.hasDeveloperFields) return undefined;
      // Everything up to the developer field count byte, with bit 5 cleared.
      const piece = bytes.slice(r.offset, r.developerSectionOffset as number);
      piece[0] = (piece[0] as number) & ~0x20;
      return piece;
    }
    const devSize = definitionOf(structure, r.definitionIndex).developerFieldsSize;
    return devSize === 0 ? undefined : bytes.subarray(r.offset, r.offset + r.length - devSize);
  });
  report.bytesRemoved = bytes.length - out.length;
  report.compressedTimestampsChanged = compressedShifts(bytes, structure, out, (r) => !isDevMessage(r));
  return { bytes: out, changed: true, report };
}

function definitionOf(structure: FitStructure, index: number): DefinitionMessage {
  return structure.records[index] as DefinitionMessage;
}

function tallyRemoved(removed: Map<number, RemovedMessages>, r: FitRecord): void {
  let entry = removed.get(r.globalMesgNum);
  if (entry === undefined) {
    entry = { globalMesgNum: r.globalMesgNum, name: mesgName(r.globalMesgNum), definitions: 0, dataMessages: 0, bytes: 0 };
    removed.set(r.globalMesgNum, entry);
  }
  if (r.kind === 'definition') entry.definitions++;
  else entry.dataMessages++;
  entry.bytes += r.length;
}

function sortRemoved(removed: Map<number, RemovedMessages>): RemovedMessages[] {
  return [...removed.values()].sort((a, b) => a.globalMesgNum - b.globalMesgNum);
}

function compressedShifts(
  before: Uint8Array,
  structure: FitStructure,
  after: Uint8Array,
  keep: (r: FitRecord) => boolean,
): number {
  const kept = structure.records.filter((r) => r.kind === 'data' && r.compressedTimestamp).map(keep);
  return countCompressedShifts(
    compressedTimestamps(before, structure),
    kept,
    compressedTimestamps(after, parseStructure(after)),
  );
}

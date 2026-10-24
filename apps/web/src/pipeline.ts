import {
  type Diagnosis,
  diagnose,
  repairTimestamps,
  stripDeveloperFields,
  stripMessages,
} from '@fit-doctor/core';

const MESG_GPS_METADATA = 160;

export interface RepairOptions {
  timestamps: boolean;
  gpsMetadata: boolean;
  unknownMessages: boolean;
  developerFields: boolean;
}

export interface PipelineResult {
  bytes: Uint8Array;
  changed: boolean;
  before: Diagnosis;
  after: Diagnosis;
  compressedTimestampsChanged: number;
}

/** Applies the selected repairs in a fixed order (they commute, so order only affects reporting). */
export function runPipeline(input: Uint8Array, options: RepairOptions, before = diagnose(input)): PipelineResult {
  let bytes = input;
  let changed = false;
  let shifted = 0;
  const step = (r: { bytes: Uint8Array; changed: boolean; report: { compressedTimestampsChanged: number } }) => {
    bytes = r.bytes;
    changed ||= r.changed;
    shifted += r.report.compressedTimestampsChanged;
  };
  if (options.timestamps) step(repairTimestamps(bytes));
  if (options.gpsMetadata) step(stripMessages(bytes, [MESG_GPS_METADATA]));
  if (options.unknownMessages) step(stripMessages(bytes, before.unknownMesgNums));
  if (options.developerFields) step(stripDeveloperFields(bytes));
  return { bytes, changed, before, after: changed ? diagnose(bytes) : before, compressedTimestampsChanged: shifted };
}

/** `<original name without .fit>_repaired.fit` */
export function repairedFileName(name: string): string {
  const stem = name.replace(/\.fit$/i, '');
  return `${stem}_repaired.fit`;
}

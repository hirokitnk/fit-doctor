import { repairTimestamps, stripDeveloperFields, stripMessages } from '@fit-doctor/core';
import { preset } from '@fit-doctor/fixtures';
import { describe, expect, it } from 'vitest';
import { repairedFileName, runPipeline } from '../src/pipeline.js';

const NONE = { timestamps: false, gpsMetadata: false, unknownMessages: false, developerFields: false };

describe('runPipeline', () => {
  const { bytes } = preset('triathlonCollapsed');

  it('returns the input unchanged when nothing is selected', () => {
    const r = runPipeline(bytes, NONE);
    expect(r.changed).toBe(false);
    expect(r.bytes).toEqual(bytes);
  });

  it('matches the core functions for each option', () => {
    expect(runPipeline(bytes, { ...NONE, timestamps: true }).bytes).toEqual(repairTimestamps(bytes).bytes);
    expect(runPipeline(bytes, { ...NONE, gpsMetadata: true }).bytes).toEqual(stripMessages(bytes, [160]).bytes);
    expect(runPipeline(bytes, { ...NONE, unknownMessages: true }).bytes).toEqual(stripMessages(bytes, [233, 534]).bytes);
    expect(runPipeline(bytes, { ...NONE, developerFields: true }).bytes).toEqual(stripDeveloperFields(bytes).bytes);
  });

  it('leaves nothing to flag when everything is selected', () => {
    const r = runPipeline(bytes, { timestamps: true, gpsMetadata: true, unknownMessages: true, developerFields: true });
    expect(r.after.findings).toEqual([]);
    expect(r.before.timestamps.endBeforeStart).toBe(178);
  });
});

describe('repairedFileName', () => {
  it.each([
    ['ride.fit', 'ride_repaired.fit'],
    ['RIDE.FIT', 'RIDE_repaired.fit'],
    ['ride', 'ride_repaired.fit'],
  ])('%s → %s', (input, expected) => expect(repairedFileName(input)).toBe(expected));
});

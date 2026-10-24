import { BaseType, FitBuilder, MesgNum, PRESET_NAMES, preset } from '@fit-doctor/fixtures';
import { sdkCanDecode, sdkCheck } from '@fit-doctor/fixtures/sdk';
import { describe, expect, it } from 'vitest';
import { diagnose } from '../src/diagnose.js';
import { FitStructureError } from '../src/repair.js';
import { stripDeveloperFields } from '../src/strip.js';
import { type DefinitionMessage, parseStructure } from '../src/structure.js';
import { recordSlices } from './helpers/records.js';

const DEV_MESGS: number[] = [MesgNum.developerDataId, MesgNum.fieldDescription];
const hasDev = (name: (typeof PRESET_NAMES)[number]) => preset(name).truth.options.developerFields;

describe('stripDeveloperFields: round trip when there is nothing to strip', () => {
  it.each(PRESET_NAMES.filter((n) => !hasDev(n)))('%s is byte-identical', (name) => {
    const { bytes } = preset(name);
    const r = stripDeveloperFields(bytes);
    expect(r.changed).toBe(false);
    expect(r.bytes).toEqual(bytes);
  });
});

describe.each(PRESET_NAMES.filter(hasDev))('stripDeveloperFields: %s', (name) => {
  const { bytes, truth } = preset(name);
  const before = parseStructure(bytes);
  const r = stripDeveloperFields(bytes);
  const after = parseStructure(r.bytes);

  it('produces a structurally valid file with no developer data left', () => {
    expect(r.changed).toBe(true);
    expect(after.errors).toEqual([]);
    expect(after.fileCrc?.valid).toBe(true);
    expect(after.records.some((x) => DEV_MESGS.includes(x.globalMesgNum))).toBe(false);
    for (const x of after.records) {
      if (x.kind === 'definition') {
        expect(x.hasDeveloperFields).toBe(false);
        expect(x.recordHeader & 0x20).toBe(0);
      }
    }
    expect(diagnose(r.bytes).developerFields.present).toBe(false);
  });

  it('keeps every other byte: definitions minus their developer section, data minus trailing developer bytes', () => {
    const expected = before.records
      .filter((x) => !DEV_MESGS.includes(x.globalMesgNum))
      .map((x) => {
        if (x.kind === 'definition') {
          const end = x.developerSectionOffset ?? x.offset + x.length;
          const piece = Array.from(bytes.subarray(x.offset, end));
          piece[0] = piece[0]! & ~0x20;
          return piece;
        }
        const dev = (before.records[x.definitionIndex] as DefinitionMessage).developerFieldsSize;
        return Array.from(bytes.subarray(x.offset, x.offset + x.length - dev));
      });
    expect(recordSlices(r.bytes, after)).toEqual(expected);
    expect(after.records.map((x) => [x.kind, x.localType, x.globalMesgNum])).toEqual(
      before.records.filter((x) => !DEV_MESGS.includes(x.globalMesgNum)).map((x) => [x.kind, x.localType, x.globalMesgNum]),
    );
  });

  it('reports what it removed', () => {
    const records = truth.dataMessageCounts[MesgNum.record]!;
    const sessions = truth.dataMessageCounts[MesgNum.session]!;
    expect(r.report.removed.map((x) => [x.globalMesgNum, x.dataMessages])).toEqual([
      [MesgNum.fieldDescription, 3],
      [MesgNum.developerDataId, 1],
    ]);
    expect(r.report.definitionsModified).toBe(
      before.records.filter((x) => x.kind === 'definition' && x.hasDeveloperFields).length,
    );
    expect(r.report.dataMessagesTruncated).toBe(records + sessions);
    expect(r.report.bytesRemoved).toBe(bytes.length - r.bytes.length);
    const devSections = before.records
      .filter((x): x is DefinitionMessage => x.kind === 'definition' && x.hasDeveloperFields)
      .reduce((n, d) => n + 1 + 3 * d.developerFields.length, 0);
    expect(r.report.bytesRemoved).toBe(
      r.report.removed.reduce((n, x) => n + x.bytes, 0) + devSections + records * 3 + sessions * 4,
    );
    expect(r.report.compressedTimestampsChanged).toBe(0);
  });

  it('leaves the diagnosis of everything else unchanged', () => {
    const d0 = diagnose(bytes);
    const d1 = diagnose(r.bytes);
    expect(d1.timestamps).toEqual(d0.timestamps);
    expect(d1.duration).toEqual(d0.duration);
    const counts = (d: typeof d0) =>
      d.messages.filter((m) => !DEV_MESGS.includes(m.globalMesgNum)).map((m) => [m.globalMesgNum, m.dataCount]);
    expect(counts(d1)).toEqual(counts(d0));
  });

  it('decodes in the Garmin SDK to the original messages without developer fields', () => {
    const sdk = sdkCheck(r.bytes);
    expect(sdk.integrity).toBe(true);
    if (!sdkCanDecode(truth.compressedCount)) return;
    expect(sdk.errors).toEqual([]);
    const original = sdkCheck(bytes).messages;
    const expected = Object.fromEntries(
      Object.entries(original)
        .filter(([k]) => k !== 'fieldDescriptionMesgs' && k !== 'developerDataIdMesgs')
        .map(([k, list]) => [k, list.map(({ developerFields: _, ...rest }) => rest)]),
    );
    expect(sdk.messages).toEqual(expected);
  });

  it('is idempotent', () => {
    const again = stripDeveloperFields(r.bytes);
    expect(again.changed).toBe(false);
    expect(again.bytes).toEqual(r.bytes);
  });
});

describe('stripDeveloperFields: edge cases', () => {
  it('clears the developer flag even when no developer fields are declared', () => {
    const bytes = new FitBuilder()
      .define(0, { globalMesgNum: 20, fields: [{ num: 3, baseType: BaseType.uint8 }], devFields: [] })
      .data(0, { 3: 99 })
      .build();
    const r = stripDeveloperFields(bytes);
    expect(r.report).toMatchObject({ definitionsModified: 1, dataMessagesTruncated: 0, bytesRemoved: 1 });
    const s = parseStructure(r.bytes);
    expect(s.errors).toEqual([]);
    expect((s.records[0] as DefinitionMessage).hasDeveloperFields).toBe(false);
    expect(sdkCheck(r.bytes).errors).toEqual([]);
  });

  it('handles developer fields on a reused local slot', () => {
    const plain = { globalMesgNum: 20, fields: [{ num: 3, baseType: BaseType.uint8 }] };
    const dev = { ...plain, devFields: [{ num: 0, size: 2, developerDataIndex: 0 }] };
    const bytes = new FitBuilder()
      .define(0, dev)
      .data(0, { 3: 1 }, [[1, 2]])
      .define(0, plain)
      .data(0, { 3: 2 })
      .define(0, dev)
      .data(0, { 3: 3 }, [[3, 4]])
      .build();
    const r = stripDeveloperFields(bytes);
    const s = parseStructure(r.bytes);
    expect(s.errors).toEqual([]);
    expect(recordSlices(r.bytes, s).filter((_, i) => s.records[i]!.kind === 'data')).toEqual([
      [0, 1],
      [0, 2],
      [0, 3],
    ]);
    expect(r.report).toMatchObject({ definitionsModified: 2, dataMessagesTruncated: 2 });
  });

  it('refuses broken files and never mutates its input', () => {
    const { bytes } = preset('developerFields');
    expect(() => stripDeveloperFields(bytes.subarray(0, 100))).toThrow(FitStructureError);
    const copy = bytes.slice();
    stripDeveloperFields(bytes);
    expect(bytes).toEqual(copy);
  });
});

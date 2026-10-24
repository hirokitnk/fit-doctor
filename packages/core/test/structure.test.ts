import { describe, expect, it } from 'vitest';
import {
  type DataMessage,
  type DefinitionMessage,
  type FitStructure,
  fieldOffset,
  parseStructure,
  readFieldUnsigned,
} from '../src/structure.js';
import { BaseType, compressedMsg, dataMsg, defMsg, fitFile, u16, u32 } from './helpers/fit-bytes.js';
import { sdkCheck } from '@fit-doctor/fixtures/sdk';

const T0 = 1_100_000_000; // seconds since FIT epoch

const FILE_ID_FIELDS: [number, number, number][] = [
  [0, 1, BaseType.enum], // type
  [1, 2, BaseType.uint16], // manufacturer
  [2, 2, BaseType.uint16], // product
  [3, 4, BaseType.uint32z], // serial_number
  [4, 4, BaseType.uint32], // time_created
];
const fileIdData = (be = false) => [4, ...u16(1, be), ...u16(4565, be), ...u32(123456, be), ...u32(T0, be)];

const RECORD_FIELDS: [number, number, number][] = [
  [253, 4, BaseType.uint32], // timestamp
  [3, 1, BaseType.uint8], // heart_rate
];
const recordData = (ts: number, hr: number, be = false) => [...u32(ts, be), hr];

function basicFile(headerSize: 12 | 14 = 14): Uint8Array {
  return fitFile(
    [
      defMsg(0, 0, FILE_ID_FIELDS),
      dataMsg(0, fileIdData()),
      defMsg(1, 20, RECORD_FIELDS),
      dataMsg(1, recordData(T0, 120)),
      dataMsg(1, recordData(T0 + 1, 121)),
      dataMsg(1, recordData(T0 + 2, 122)),
      // Unknown global message numbers seen in real devices.
      defMsg(2, 233, [[0, 2, BaseType.uint16]]),
      dataMsg(2, u16(7)),
      defMsg(3, 534, [[0, 1, BaseType.uint8]]),
      dataMsg(3, [9]),
    ],
    { headerSize },
  );
}

const definitions = (s: FitStructure) => s.records.filter((r): r is DefinitionMessage => r.kind === 'definition');
const dataMessages = (s: FitStructure) => s.records.filter((r): r is DataMessage => r.kind === 'data');
const defOf = (s: FitStructure, m: DataMessage) => s.records[m.definitionIndex] as DefinitionMessage;

/** Records must tile the data area exactly, with no gaps or overlaps. */
function expectContiguous(s: FitStructure): void {
  let pos = s.dataStart;
  for (const r of s.records) {
    expect(r.offset).toBe(pos);
    pos += r.length;
  }
  expect(pos).toBe(s.dataEnd);
}

describe('parseStructure: well-formed files', () => {
  it('parses the 14-byte header and validates both CRCs', () => {
    const bytes = basicFile();
    const s = parseStructure(bytes);
    expect(s.errors).toEqual([]);
    expect(s.header).toMatchObject({ headerSize: 14, protocolVersion: 0x20, profileVersion: 21218, dataType: '.FIT' });
    expect(s.header?.dataSize).toBe(bytes.length - 14 - 2);
    expect(s.headerCrcStatus).toBe('valid');
    expect(s.fileCrc?.valid).toBe(true);
    expect(s.trailingBytes).toBe(0);
    expect(sdkCheck(bytes).integrity).toBe(true);
  });

  it('scans every record with correct kinds, global numbers and lengths', () => {
    const s = parseStructure(basicFile());
    expectContiguous(s);
    expect(s.records.map((r) => [r.kind, r.globalMesgNum, r.length])).toEqual([
      ['definition', 0, 6 + 5 * 3],
      ['data', 0, 1 + 13],
      ['definition', 20, 6 + 2 * 3],
      ['data', 20, 1 + 5],
      ['data', 20, 1 + 5],
      ['data', 20, 1 + 5],
      ['definition', 233, 6 + 3],
      ['data', 233, 1 + 2],
      ['definition', 534, 6 + 3],
      ['data', 534, 1 + 1],
    ]);
    for (const [i, r] of s.records.entries()) expect(r.index).toBe(i);
  });

  it('computes field offsets and reads field values', () => {
    const bytes = basicFile();
    const s = parseStructure(bytes);
    const fileIdDef = definitions(s)[0]!;
    expect(fileIdDef.fields.map((f) => f.offset)).toEqual([0, 1, 3, 5, 9]);
    expect(fileIdDef.fieldsSize).toBe(13);

    const records = dataMessages(s).filter((m) => m.globalMesgNum === 20);
    expect(records.map((m) => readFieldUnsigned(bytes, defOf(s, m), m, 253))).toEqual([T0, T0 + 1, T0 + 2]);
    expect(records.map((m) => readFieldUnsigned(bytes, defOf(s, m), m, 3))).toEqual([120, 121, 122]);
    expect(fieldOffset(defOf(s, records[0]!), records[0]!, 3)).toBe(records[0]!.offset + 1 + 4);
    expect(readFieldUnsigned(bytes, defOf(s, records[0]!), records[0]!, 99)).toBeNull();
    expect(fieldOffset(defOf(s, records[0]!), records[0]!, 99)).toBeNull();
  });

  it('agrees with the Garmin SDK on known-message counts and values', () => {
    const bytes = basicFile();
    const sdk = sdkCheck(bytes);
    expect(sdk.errors).toEqual([]);
    expect(sdk.messages.fileIdMesgs).toHaveLength(1);
    expect(sdk.messages.recordMesgs?.map((m) => m.timestamp)).toEqual([T0, T0 + 1, T0 + 2]);
    // The SDK silently drops unknown message numbers; the scanner must keep them.
    const s = parseStructure(bytes);
    expect(dataMessages(s).filter((m) => m.globalMesgNum === 233)).toHaveLength(1);
    expect(dataMessages(s).filter((m) => m.globalMesgNum === 534)).toHaveLength(1);
  });

  it('does not modify its input', () => {
    const bytes = basicFile();
    const snapshot = bytes.slice();
    parseStructure(bytes);
    expect(bytes).toEqual(snapshot);
  });

  it('handles an empty record area', () => {
    const s = parseStructure(fitFile([]));
    expect(s.errors).toEqual([]);
    expect(s.records).toEqual([]);
    expect(s.fileCrc?.valid).toBe(true);
  });
});

describe('parseStructure: header variants', () => {
  it('handles a 12-byte header without CRC field', () => {
    const bytes = basicFile(12);
    const s = parseStructure(bytes);
    expect(s.errors).toEqual([]);
    expect(s.header).toMatchObject({ headerSize: 12, headerCrc: null, computedHeaderCrc: null });
    expect(s.headerCrcStatus).toBe('absent');
    expect(s.dataStart).toBe(12);
    expect(s.records[0]?.offset).toBe(12);
    expectContiguous(s);
    expect(s.fileCrc?.valid).toBe(true);
    const sdk = sdkCheck(bytes);
    expect(sdk.integrity).toBe(true);
    expect(sdk.errors).toEqual([]);
  });

  it('reports a 0x0000 header CRC as "zero" (allowed by the protocol)', () => {
    const bytes = fitFile([defMsg(0, 20, RECORD_FIELDS)], { headerCrc: 0 });
    expect(parseStructure(bytes).headerCrcStatus).toBe('zero');
    expect(sdkCheck(bytes).integrity).toBe(true);
  });

  it('reports a wrong header CRC as "invalid"', () => {
    const bytes = fitFile([defMsg(0, 20, RECORD_FIELDS)], { headerCrc: 0x1234 });
    const s = parseStructure(bytes);
    expect(s.headerCrcStatus).toBe('invalid');
    expect(s.errors).toEqual([]); // CRC problems are not structural errors
    expect(sdkCheck(bytes).integrity).toBe(false);
  });

  it('reports a wrong file CRC', () => {
    const bytes = basicFile();
    bytes[bytes.length - 1] ^= 0x01;
    const s = parseStructure(bytes);
    expect(s.fileCrc).toMatchObject({ valid: false });
    expect(s.fileCrc?.stored).not.toBe(s.fileCrc?.computed);
    expect(s.records).toHaveLength(10);
    expect(sdkCheck(bytes).integrity).toBe(false);
  });

  it('counts trailing bytes after the file CRC without scanning them', () => {
    const bytes = Uint8Array.from([...basicFile(), 0x0e, 0x10]);
    const s = parseStructure(bytes);
    expect(s.trailingBytes).toBe(2);
    expect(s.fileCrc?.valid).toBe(true);
    expect(s.errors).toEqual([]);
  });
});

describe('parseStructure: big-endian definitions', () => {
  const bytes = fitFile([
    defMsg(0, 0, FILE_ID_FIELDS, { bigEndian: true }),
    dataMsg(0, fileIdData(true)),
    defMsg(1, 20, RECORD_FIELDS, { bigEndian: true }),
    dataMsg(1, recordData(T0, 130, true)),
    dataMsg(1, recordData(T0 + 5, 131, true)),
    // Little-endian definition mixed into the same file.
    defMsg(2, 20, RECORD_FIELDS),
    dataMsg(2, recordData(T0 + 10, 132)),
  ]);

  it('reads the global message number with the declared byte order', () => {
    const s = parseStructure(bytes);
    expect(s.errors).toEqual([]);
    expectContiguous(s);
    const defs = definitions(s);
    expect(defs.map((d) => [d.endianness, d.globalMesgNum])).toEqual([
      ['big', 0],
      ['big', 20],
      ['little', 20],
    ]);
  });

  it('reads multi-byte field values with the declared byte order, matching the SDK', () => {
    const s = parseStructure(bytes);
    const records = dataMessages(s).filter((m) => m.globalMesgNum === 20);
    const ours = records.map((m) => readFieldUnsigned(bytes, defOf(s, m), m, 253));
    expect(ours).toEqual([T0, T0 + 5, T0 + 10]);

    const sdk = sdkCheck(bytes);
    expect(sdk.errors).toEqual([]);
    expect(sdk.messages.recordMesgs?.map((m) => m.timestamp)).toEqual(ours);
    expect(sdk.messages.fileIdMesgs?.[0]).toMatchObject({ product: 4565, serialNumber: 123456 });
  });
});

describe('parseStructure: compressed timestamp headers', () => {
  const bytes = fitFile([
    defMsg(0, 20, RECORD_FIELDS),
    dataMsg(0, recordData(T0, 100)),
    // Local type 1 for compressed records: heart_rate only.
    defMsg(1, 20, [[3, 1, BaseType.uint8]]),
    compressedMsg(1, 5, [101]),
    compressedMsg(1, 31, [102]),
    // Local type 3 is the highest a compressed header can address.
    defMsg(3, 233, [[0, 2, BaseType.uint16]]),
    compressedMsg(3, 0, u16(0xbeef)),
    // A normal-header data message after compressed ones.
    dataMsg(0, recordData(T0 + 40, 103)),
  ]);

  it('takes the local type from bits 5-6 and the time offset from bits 0-4', () => {
    const s = parseStructure(bytes);
    expect(s.errors).toEqual([]);
    expectContiguous(s);
    const compressed = dataMessages(s).filter((m) => m.compressedTimestamp);
    expect(compressed.map((m) => [m.recordHeader, m.localType, m.timeOffset, m.globalMesgNum, m.length])).toEqual([
      [0xa5, 1, 5, 20, 2],
      [0xbf, 1, 31, 20, 2],
      [0xe0, 3, 0, 233, 3],
    ]);
    const normal = dataMessages(s).filter((m) => !m.compressedTimestamp);
    expect(normal.every((m) => m.timeOffset === null)).toBe(true);
    expect(normal).toHaveLength(2);
  });

  it('passes the SDK CRC integrity check (the SDK cannot decode compressed headers)', () => {
    const sdk = sdkCheck(bytes);
    expect(sdk.integrity).toBe(true);
    // Documented limitation of @garmin/fitsdk: compressed timestamp messages throw during read().
    expect(String(sdk.errors[0])).toMatch(/compressed timestamp/);
  });
});

describe('parseStructure: developer fields', () => {
  const bytes = fitFile([
    // developer_data_id: developer_data_index(3), application_id(1)
    defMsg(0, 207, [
      [3, 1, BaseType.uint8],
      [1, 16, BaseType.byte],
    ]),
    dataMsg(0, [0, ...Array.from({ length: 16 }, (_, i) => i + 1)]),
    // field_description: developer_data_index(0), field_definition_number(1), fit_base_type_id(2), field_name(3)
    defMsg(1, 206, [
      [0, 1, BaseType.uint8],
      [1, 1, BaseType.uint8],
      [2, 1, BaseType.uint8],
      [3, 8, BaseType.string],
    ]),
    dataMsg(1, [0, 0, BaseType.uint16, ...Array.from('power\0\0\0', (c) => c.charCodeAt(0))]),
    // record with one regular field and two developer fields (uint16 + 3 opaque bytes)
    defMsg(2, 20, RECORD_FIELDS, {
      devFields: [
        [0, 2, 0],
        [1, 3, 0],
      ],
    }),
    dataMsg(2, [...recordData(T0, 140), ...u16(250), 0xaa, 0xbb, 0xcc]),
    dataMsg(2, [...recordData(T0 + 1, 141), ...u16(260), 0xdd, 0xee, 0xff]),
    // Bit 5 set but zero developer fields declared.
    defMsg(3, 20, RECORD_FIELDS, { devFields: [] }),
    dataMsg(3, recordData(T0 + 2, 142)),
  ]);

  it('parses the developer field section of definitions', () => {
    const s = parseStructure(bytes);
    expect(s.errors).toEqual([]);
    expectContiguous(s);
    const def = definitions(s).find((d) => d.localType === 2)!;
    expect(def.hasDeveloperFields).toBe(true);
    expect(def.recordHeader & 0x20).toBe(0x20);
    expect(def.developerFields).toEqual([
      { num: 0, size: 2, developerDataIndex: 0, offset: 5 },
      { num: 1, size: 3, developerDataIndex: 0, offset: 7 },
    ]);
    expect(def.fieldsSize).toBe(5);
    expect(def.developerFieldsSize).toBe(5);
    // header + reserved/arch/global/count (5) + 2 fields + dev count + 2 dev fields
    expect(def.length).toBe(1 + 5 + 6 + 1 + 6);
    expect(def.developerSectionOffset).toBe(def.offset + 1 + 5 + 6);
    expect(bytes[def.developerSectionOffset!]).toBe(2);
  });

  it('sizes data messages to include trailing developer bytes', () => {
    const s = parseStructure(bytes);
    const records = dataMessages(s).filter((m) => m.globalMesgNum === 20);
    expect(records.map((m) => m.length)).toEqual([1 + 10, 1 + 10, 1 + 5]);
    expect(records.map((m) => readFieldUnsigned(bytes, defOf(s, m), m, 253))).toEqual([T0, T0 + 1, T0 + 2]);
  });

  it('handles the developer flag with zero developer fields', () => {
    const s = parseStructure(bytes);
    const def = definitions(s).find((d) => d.localType === 3)!;
    expect(def.hasDeveloperFields).toBe(true);
    expect(def.developerFields).toEqual([]);
    expect(def.developerFieldsSize).toBe(0);
    expect(def.length).toBe(1 + 5 + 6 + 1);
  });

  it('matches the SDK decode of developer values', () => {
    const sdk = sdkCheck(bytes);
    expect(sdk.errors).toEqual([]);
    const recs = sdk.messages.recordMesgs!;
    expect(recs.map((m) => m.timestamp)).toEqual([T0, T0 + 1, T0 + 2]);
    expect(recs[0]?.developerFields).toEqual({ 0: 250 });
    expect(recs[1]?.developerFields).toEqual({ 0: 260 });
  });
});

describe('parseStructure: local message type reuse', () => {
  it('maps each data message to the most recent definition for its slot', () => {
    const bytes = fitFile([
      defMsg(0, 20, RECORD_FIELDS),
      dataMsg(0, recordData(T0, 1)),
      defMsg(0, 160, [[253, 4, BaseType.uint32]]), // gps_metadata reuses slot 0
      dataMsg(0, u32(T0 + 1)),
      dataMsg(0, u32(T0 + 2)),
      defMsg(0, 20, RECORD_FIELDS), // slot 0 back to record
      dataMsg(0, recordData(T0 + 3, 2)),
    ]);
    const s = parseStructure(bytes);
    expect(s.errors).toEqual([]);
    expectContiguous(s);
    expect(dataMessages(s).map((m) => [m.globalMesgNum, m.definitionIndex, m.length])).toEqual([
      [20, 0, 6],
      [160, 2, 5],
      [160, 2, 5],
      [20, 5, 6],
    ]);
    expect(sdkCheck(bytes).errors).toEqual([]);
  });

  it('supports all 16 local slots for normal headers', () => {
    const records: number[][] = [];
    for (let local = 0; local < 16; local++) {
      records.push(defMsg(local, 300 + local, [[0, 1, BaseType.uint8]]), dataMsg(local, [local]));
    }
    const s = parseStructure(fitFile(records));
    expect(s.errors).toEqual([]);
    expect(dataMessages(s).map((m) => [m.localType, m.globalMesgNum])).toEqual(
      Array.from({ length: 16 }, (_, i) => [i, 300 + i]),
    );
  });
});

describe('parseStructure: malformed input', () => {
  it('rejects input shorter than a header', () => {
    const s = parseStructure(Uint8Array.of(14, 0x10, 0, 0));
    expect(s.header).toBeNull();
    expect(s.errors.map((e) => e.code)).toEqual(['file-too-short']);
  });

  it('rejects an unsupported header size', () => {
    const bytes = basicFile();
    bytes[0] = 13;
    expect(parseStructure(bytes).errors.map((e) => e.code)).toEqual(['bad-header-size']);
  });

  it('rejects a bad signature', () => {
    const bytes = basicFile();
    bytes[8] = 0x2f;
    const s = parseStructure(bytes);
    expect(s.header).toBeNull();
    expect(s.errors.map((e) => e.code)).toEqual(['bad-signature']);
  });

  it('reports a truncated file and keeps the records that fit', () => {
    const full = basicFile();
    const cut = full.subarray(0, full.length - 10);
    const s = parseStructure(cut);
    expect(s.fileCrc).toBeNull();
    expect(s.errors.map((e) => e.code)).toEqual(['data-truncated', 'record-truncated']);
    expect(s.records.length).toBeGreaterThan(0);
    expect(s.records.length).toBeLessThan(10);
    const last = s.records[s.records.length - 1]!;
    expect(last.offset + last.length).toBeLessThanOrEqual(cut.length);
  });

  it('reports a data message whose local type was never defined', () => {
    const bytes = fitFile([defMsg(0, 20, RECORD_FIELDS), dataMsg(0, recordData(T0, 1)), dataMsg(5, [0])]);
    const s = parseStructure(bytes);
    expect(s.errors).toMatchObject([{ code: 'undefined-local-type', offset: 14 + 12 + 6 }]);
    expect(s.records).toHaveLength(2);
  });

  it('reports a compressed header pointing at an undefined slot', () => {
    const s = parseStructure(fitFile([defMsg(0, 20, RECORD_FIELDS), compressedMsg(2, 1, [0])]));
    expect(s.errors.map((e) => e.code)).toEqual(['undefined-local-type']);
  });

  it('reports an invalid architecture byte', () => {
    const def = defMsg(0, 20, RECORD_FIELDS);
    def[2] = 7;
    const s = parseStructure(fitFile([def]));
    expect(s.errors).toMatchObject([{ code: 'bad-architecture', offset: 14 + 2 }]);
  });

  it('reports a definition whose field list runs past the data area', () => {
    const def = defMsg(0, 20, RECORD_FIELDS);
    def[5] = 40; // claims 40 fields
    const s = parseStructure(fitFile([def]));
    expect(s.errors.map((e) => e.code)).toEqual(['record-truncated']);
    expect(s.records).toEqual([]);
  });

  it('reports a data message that runs past the declared data size', () => {
    const records = [defMsg(0, 20, RECORD_FIELDS), dataMsg(0, recordData(T0, 1))];
    const bodyLength = records.flat().length;
    const s = parseStructure(fitFile(records, { dataSize: bodyLength - 1 }));
    expect(s.errors.map((e) => e.code)).toEqual(['record-truncated']);
    expect(s.records).toHaveLength(1);
  });

  it('never throws on random garbage after a valid header', () => {
    for (let seed = 1; seed <= 200; seed++) {
      let x = seed;
      const body = Array.from({ length: 64 }, () => ((x = (x * 1103515245 + 12345) >>> 0) >>> 16) & 0xff);
      expect(() => parseStructure(fitFile([body]))).not.toThrow();
    }
  });
});

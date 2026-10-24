import { type Endianness, readUint16LE, readUnsigned } from './bytes.js';
import { crc16 } from './crc.js';
import { FILE_CRC_SIZE, type FitHeader, type HeaderCrcStatus, headerCrcStatus, parseHeader } from './header.js';

export const RECORD_HEADER_COMPRESSED = 0x80;
export const RECORD_HEADER_DEFINITION = 0x40;
export const RECORD_HEADER_DEVELOPER_DATA = 0x20;

export interface FieldDefinition {
  num: number;
  size: number;
  baseType: number;
  /** Offset of this field within the data message, counted from the byte after the record header. */
  offset: number;
}

export interface DeveloperFieldDefinition {
  num: number;
  size: number;
  developerDataIndex: number;
  /** Offset within the data message, counted from the byte after the record header. */
  offset: number;
}

export interface DefinitionMessage {
  kind: 'definition';
  /** Position in `FitStructure.records`. */
  index: number;
  /** Absolute offset of the record header byte. */
  offset: number;
  /** Total length in bytes, including the record header. */
  length: number;
  recordHeader: number;
  localType: number;
  endianness: Endianness;
  globalMesgNum: number;
  fields: FieldDefinition[];
  /** True when record header bit 5 is set, even if the developer field count is 0. */
  hasDeveloperFields: boolean;
  developerFields: DeveloperFieldDefinition[];
  /** Absolute offset of the developer field count byte, or null when `hasDeveloperFields` is false. */
  developerSectionOffset: number | null;
  /** Sum of regular field sizes. */
  fieldsSize: number;
  /** Sum of developer field sizes. */
  developerFieldsSize: number;
}

export interface DataMessage {
  kind: 'data';
  index: number;
  offset: number;
  /** Total length in bytes, including the record header. */
  length: number;
  recordHeader: number;
  localType: number;
  globalMesgNum: number;
  /** Index in `FitStructure.records` of the definition that governs this message. */
  definitionIndex: number;
  compressedTimestamp: boolean;
  /** 5-bit time offset from a compressed timestamp header; null for normal headers. */
  timeOffset: number | null;
}

export type FitRecord = DefinitionMessage | DataMessage;

export type ParseErrorCode =
  | 'file-too-short'
  | 'bad-header-size'
  | 'bad-signature'
  | 'data-truncated'
  | 'record-truncated'
  | 'bad-architecture'
  | 'undefined-local-type';

export interface ParseError {
  code: ParseErrorCode;
  /** Absolute byte offset the error refers to. */
  offset: number;
  message: string;
}

export interface FileCrcInfo {
  stored: number;
  computed: number;
  valid: boolean;
}

export interface FitStructure {
  /** Null when the header itself is unusable. */
  header: FitHeader | null;
  headerCrcStatus: HeaderCrcStatus | null;
  records: FitRecord[];
  /** Absolute offset where the record area starts (= header size). */
  dataStart: number;
  /** Absolute offset where the record area ends according to the header (= headerSize + dataSize). */
  dataEnd: number;
  /** Null when the file is too short to contain the CRC at the declared position. */
  fileCrc: FileCrcInfo | null;
  /** Bytes after the file CRC (e.g. chained FIT files). Not scanned. */
  trailingBytes: number;
  /**
   * Structural problems. Scanning stops at the first record-level error, so `records`
   * holds everything that could be read before it.
   */
  errors: ParseError[];
}

/**
 * Scans the record structure of a FIT file without modifying or decoding field values.
 * Never throws for malformed input; problems are reported in `errors`.
 */
export function parseStructure(bytes: Uint8Array): FitStructure {
  const result: FitStructure = {
    header: null,
    headerCrcStatus: null,
    records: [],
    dataStart: 0,
    dataEnd: 0,
    fileCrc: null,
    trailingBytes: 0,
    errors: [],
  };

  const parsedHeader = parseHeader(bytes);
  if (!parsedHeader.ok) {
    result.errors.push({ ...parsedHeader.error, offset: 0 });
    return result;
  }
  const header = parsedHeader.header;
  result.header = header;
  result.headerCrcStatus = headerCrcStatus(header);
  result.dataStart = header.headerSize;
  result.dataEnd = header.headerSize + header.dataSize;

  if (result.dataEnd + FILE_CRC_SIZE <= bytes.length) {
    const stored = readUint16LE(bytes, result.dataEnd);
    const computed = crc16(bytes, 0, result.dataEnd);
    result.fileCrc = { stored, computed, valid: stored === computed };
    result.trailingBytes = bytes.length - result.dataEnd - FILE_CRC_SIZE;
  } else {
    result.errors.push({
      code: 'data-truncated',
      offset: bytes.length,
      message: `header declares ${result.dataEnd + FILE_CRC_SIZE} bytes but file is ${bytes.length} bytes`,
    });
  }

  scanRecords(bytes, result.dataStart, Math.min(result.dataEnd, bytes.length), result);
  return result;
}

function scanRecords(bytes: Uint8Array, start: number, end: number, result: FitStructure): void {
  const { records, errors } = result;
  const localDefinitions: (DefinitionMessage | undefined)[] = [];
  let pos = start;

  const truncated = (what: string): void => {
    errors.push({ code: 'record-truncated', offset: pos, message: `${what} at offset ${pos} runs past end of data` });
  };

  while (pos < end) {
    const recordHeader = bytes[pos] as number;

    if ((recordHeader & RECORD_HEADER_DEFINITION) !== 0 && (recordHeader & RECORD_HEADER_COMPRESSED) === 0) {
      const localType = recordHeader & 0x0f;
      // record header + reserved + architecture + global number (2) + field count
      if (pos + 6 > end) {
        truncated('definition message');
        return;
      }
      const architecture = bytes[pos + 2] as number;
      if (architecture !== 0 && architecture !== 1) {
        errors.push({
          code: 'bad-architecture',
          offset: pos + 2,
          message: `definition message at offset ${pos} has architecture byte ${architecture}; expected 0 or 1`,
        });
        return;
      }
      const endianness: Endianness = architecture === 0 ? 'little' : 'big';
      const globalMesgNum = readUnsigned(bytes, pos + 3, 2, endianness);
      const fieldCount = bytes[pos + 5] as number;
      let p = pos + 6;
      if (p + fieldCount * 3 > end) {
        truncated('definition message');
        return;
      }
      const fields: FieldDefinition[] = [];
      let dataOffset = 0;
      for (let i = 0; i < fieldCount; i++, p += 3) {
        const size = bytes[p + 1] as number;
        fields.push({ num: bytes[p] as number, size, baseType: bytes[p + 2] as number, offset: dataOffset });
        dataOffset += size;
      }
      const fieldsSize = dataOffset;

      const hasDeveloperFields = (recordHeader & RECORD_HEADER_DEVELOPER_DATA) !== 0;
      const developerFields: DeveloperFieldDefinition[] = [];
      let developerSectionOffset: number | null = null;
      if (hasDeveloperFields) {
        if (p + 1 > end) {
          truncated('definition message');
          return;
        }
        developerSectionOffset = p;
        const devCount = bytes[p] as number;
        p += 1;
        if (p + devCount * 3 > end) {
          truncated('definition message');
          return;
        }
        for (let i = 0; i < devCount; i++, p += 3) {
          const size = bytes[p + 1] as number;
          developerFields.push({
            num: bytes[p] as number,
            size,
            developerDataIndex: bytes[p + 2] as number,
            offset: dataOffset,
          });
          dataOffset += size;
        }
      }

      const definition: DefinitionMessage = {
        kind: 'definition',
        index: records.length,
        offset: pos,
        length: p - pos,
        recordHeader,
        localType,
        endianness,
        globalMesgNum,
        fields,
        hasDeveloperFields,
        developerFields,
        developerSectionOffset,
        fieldsSize,
        developerFieldsSize: dataOffset - fieldsSize,
      };
      records.push(definition);
      localDefinitions[localType] = definition;
      pos = p;
      continue;
    }

    const compressedTimestamp = (recordHeader & RECORD_HEADER_COMPRESSED) !== 0;
    const localType = compressedTimestamp ? (recordHeader >> 5) & 0x03 : recordHeader & 0x0f;
    const definition = localDefinitions[localType];
    if (definition === undefined) {
      errors.push({
        code: 'undefined-local-type',
        offset: pos,
        message: `data message at offset ${pos} uses local message type ${localType}, which has no definition`,
      });
      return;
    }
    const length = 1 + dataMessageSize(definition);
    if (pos + length > end) {
      truncated('data message');
      return;
    }
    records.push({
      kind: 'data',
      index: records.length,
      offset: pos,
      length,
      recordHeader,
      localType,
      globalMesgNum: definition.globalMesgNum,
      definitionIndex: definition.index,
      compressedTimestamp,
      timeOffset: compressedTimestamp ? recordHeader & 0x1f : null,
    });
    pos += length;
  }
}

/** Size of a data message governed by `definition`, excluding the record header. */
export function dataMessageSize(definition: DefinitionMessage): number {
  return definition.fieldsSize + definition.developerFieldsSize;
}

export function findField(definition: DefinitionMessage, fieldNum: number): FieldDefinition | undefined {
  return definition.fields.find((f) => f.num === fieldNum);
}

/** Absolute offset of a field's first byte inside a data message, or null if the definition lacks the field. */
export function fieldOffset(definition: DefinitionMessage, message: DataMessage, fieldNum: number): number | null {
  const field = findField(definition, fieldNum);
  return field === undefined ? null : message.offset + 1 + field.offset;
}

/**
 * Reads the raw unsigned value of a 1/2/4-byte field from a data message.
 * Returns null when the definition lacks the field or its size is not 1, 2 or 4.
 * Invalid-value sentinels (0xFF, 0xFFFF, 0xFFFFFFFF) are returned as-is.
 */
export function readFieldUnsigned(
  bytes: Uint8Array,
  definition: DefinitionMessage,
  message: DataMessage,
  fieldNum: number,
): number | null {
  const field = findField(definition, fieldNum);
  if (field === undefined || (field.size !== 1 && field.size !== 2 && field.size !== 4)) return null;
  return readUnsigned(bytes, message.offset + 1 + field.offset, field.size, definition.endianness);
}

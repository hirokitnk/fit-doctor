import { readUint16LE, readUint32LE, writeUint16LE } from './bytes.js';
import { crc16 } from './crc.js';

export const FIT_SIGNATURE = '.FIT';
export const HEADER_SIZE_NO_CRC = 12;
export const HEADER_SIZE_WITH_CRC = 14;
export const FILE_CRC_SIZE = 2;

export interface FitHeader {
  /** 12 or 14. */
  headerSize: number;
  protocolVersion: number;
  profileVersion: number;
  /** Size of the record area, excluding header and file CRC. */
  dataSize: number;
  dataType: string;
  /** Stored header CRC; null for 12-byte headers. */
  headerCrc: number | null;
  /** CRC of bytes 0..11; null for 12-byte headers. */
  computedHeaderCrc: number | null;
}

/**
 * - `valid`: stored CRC matches
 * - `zero`: stored CRC is 0x0000, which the FIT protocol allows to mean "not computed"
 * - `invalid`: stored CRC is non-zero and does not match
 * - `absent`: 12-byte header has no CRC field
 */
export type HeaderCrcStatus = 'valid' | 'zero' | 'invalid' | 'absent';

export type HeaderError =
  | { code: 'file-too-short'; message: string }
  | { code: 'bad-header-size'; message: string }
  | { code: 'bad-signature'; message: string };

export type HeaderParseResult = { ok: true; header: FitHeader } | { ok: false; error: HeaderError };

export function parseHeader(bytes: Uint8Array): HeaderParseResult {
  if (bytes.length < HEADER_SIZE_NO_CRC) {
    return {
      ok: false,
      error: { code: 'file-too-short', message: `file is ${bytes.length} bytes; a FIT header needs at least 12` },
    };
  }
  const headerSize = bytes[0] as number;
  if (headerSize !== HEADER_SIZE_NO_CRC && headerSize !== HEADER_SIZE_WITH_CRC) {
    return { ok: false, error: { code: 'bad-header-size', message: `header size is ${headerSize}; expected 12 or 14` } };
  }
  if (bytes.length < headerSize) {
    return {
      ok: false,
      error: { code: 'file-too-short', message: `file is ${bytes.length} bytes; header declares ${headerSize}` },
    };
  }
  const dataType = String.fromCharCode(bytes[8] as number, bytes[9] as number, bytes[10] as number, bytes[11] as number);
  if (dataType !== FIT_SIGNATURE) {
    return { ok: false, error: { code: 'bad-signature', message: `signature is ${JSON.stringify(dataType)}; expected ".FIT"` } };
  }
  const hasCrc = headerSize === HEADER_SIZE_WITH_CRC;
  return {
    ok: true,
    header: {
      headerSize,
      protocolVersion: bytes[1] as number,
      profileVersion: readUint16LE(bytes, 2),
      dataSize: readUint32LE(bytes, 4),
      dataType,
      headerCrc: hasCrc ? readUint16LE(bytes, 12) : null,
      computedHeaderCrc: hasCrc ? crc16(bytes, 0, 12) : null,
    },
  };
}

export function headerCrcStatus(header: FitHeader): HeaderCrcStatus {
  if (header.headerCrc === null) return 'absent';
  if (header.headerCrc === header.computedHeaderCrc) return 'valid';
  if (header.headerCrc === 0) return 'zero';
  return 'invalid';
}

/**
 * Returns a copy of `bytes` with the header CRC (14-byte headers only) and the file CRC
 * rewritten from the current contents. `data size` is taken from the header as-is.
 * Bytes after the file CRC (e.g. a chained FIT file) are preserved untouched.
 */
export function recomputeCrc(bytes: Uint8Array): Uint8Array {
  const parsed = parseHeader(bytes);
  if (!parsed.ok) {
    throw new Error(`cannot recompute CRC: ${parsed.error.message}`);
  }
  const { headerSize, dataSize } = parsed.header;
  const dataEnd = headerSize + dataSize;
  if (dataEnd + FILE_CRC_SIZE > bytes.length) {
    throw new Error(
      `cannot recompute CRC: header declares ${dataEnd + FILE_CRC_SIZE} bytes but file is ${bytes.length} bytes`,
    );
  }
  const out = bytes.slice();
  if (headerSize === HEADER_SIZE_WITH_CRC) {
    writeUint16LE(out, 12, crc16(out, 0, 12));
  }
  writeUint16LE(out, dataEnd, crc16(out, 0, dataEnd));
  return out;
}

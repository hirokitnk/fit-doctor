import { type DataMessage, type DefinitionMessage, findField } from './structure.js';
import { readUnsigned } from './bytes.js';

/** 1989-12-31T00:00:00Z as a Unix timestamp in seconds. */
export const FIT_EPOCH_UNIX_SECONDS = 631_065_600;

export const INVALID_UINT8 = 0xff;
export const INVALID_UINT16 = 0xffff;
export const INVALID_UINT32 = 0xffffffff;

export function fitTimeToDate(fitSeconds: number): Date {
  return new Date((fitSeconds + FIT_EPOCH_UNIX_SECONDS) * 1000);
}

/**
 * Reads an unsigned field that must have exactly `size` bytes, returning null when the field is
 * absent, has an unexpected size, or holds the invalid sentinel for that size.
 */
export function readValidUnsigned(
  bytes: Uint8Array,
  definition: DefinitionMessage,
  message: DataMessage,
  fieldNum: number,
  size: 1 | 2 | 4,
): number | null {
  const field = findField(definition, fieldNum);
  if (field === undefined || field.size !== size) return null;
  const value = readUnsigned(bytes, message.offset + 1 + field.offset, size, definition.endianness);
  const invalid = size === 1 ? INVALID_UINT8 : size === 2 ? INVALID_UINT16 : INVALID_UINT32;
  return value === invalid ? null : value;
}

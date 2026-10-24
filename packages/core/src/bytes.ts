export type Endianness = 'little' | 'big';

export function readUint16LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] as number) | ((bytes[offset + 1] as number) << 8);
}

export function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] as number) |
      ((bytes[offset + 1] as number) << 8) |
      ((bytes[offset + 2] as number) << 16) |
      ((bytes[offset + 3] as number) << 24)) >>>
    0
  );
}

export function writeUint16LE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}

export function writeUint32LE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

/**
 * Reads an unsigned integer of 1, 2 or 4 bytes with the given byte order.
 * Larger sizes are rejected because they cannot be represented exactly as a JS number.
 */
export function readUnsigned(bytes: Uint8Array, offset: number, size: number, endianness: Endianness): number {
  if (size !== 1 && size !== 2 && size !== 4) {
    throw new RangeError(`unsupported integer size: ${size}`);
  }
  let value = 0;
  for (let i = 0; i < size; i++) {
    const b = bytes[endianness === 'little' ? offset + size - 1 - i : offset + i] as number;
    value = value * 256 + b;
  }
  return value;
}

/** Writes an unsigned integer of 1, 2 or 4 bytes with the given byte order. */
export function writeUnsigned(
  bytes: Uint8Array,
  offset: number,
  size: number,
  endianness: Endianness,
  value: number,
): void {
  if (size !== 1 && size !== 2 && size !== 4) {
    throw new RangeError(`unsupported integer size: ${size}`);
  }
  if (!Number.isInteger(value) || value < 0 || value >= 2 ** (8 * size)) {
    throw new RangeError(`value ${value} does not fit in ${size} bytes`);
  }
  let v = value;
  for (let i = 0; i < size; i++) {
    bytes[endianness === 'little' ? offset + i : offset + size - 1 - i] = v % 256;
    v = Math.floor(v / 256);
  }
}

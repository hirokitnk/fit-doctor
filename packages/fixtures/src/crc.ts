// Bit-by-bit CRC-16/ARC. Intentionally independent of @fit-doctor/core's table-driven
// implementation so fixtures can cross-check it.
export function crc16Bitwise(bytes: ArrayLike<number>, start = 0, end = bytes.length): number {
  let crc = 0;
  for (let i = start; i < end; i++) {
    crc ^= bytes[i] as number;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
  }
  return crc;
}

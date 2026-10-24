/**
 * FIT CRC-16 (nibble-table variant; equivalent to CRC-16/ARC).
 */
const CRC_TABLE: readonly number[] = [
  0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401,
  0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400,
];

/** Feeds one byte into a running CRC: low nibble first, then high nibble. */
export function crc16Update(crc: number, byte: number): number {
  let tmp = CRC_TABLE[crc & 0xf] as number;
  crc = (crc >> 4) & 0x0fff;
  crc = crc ^ tmp ^ (CRC_TABLE[byte & 0xf] as number);

  tmp = CRC_TABLE[crc & 0xf] as number;
  crc = (crc >> 4) & 0x0fff;
  crc = crc ^ tmp ^ (CRC_TABLE[(byte >> 4) & 0xf] as number);

  return crc;
}

/** CRC of `bytes[start..end)`. `initial` allows continuing a previous computation. */
export function crc16(bytes: Uint8Array, start = 0, end = bytes.length, initial = 0): number {
  let crc = initial;
  for (let i = start; i < end; i++) {
    crc = crc16Update(crc, bytes[i] as number);
  }
  return crc;
}

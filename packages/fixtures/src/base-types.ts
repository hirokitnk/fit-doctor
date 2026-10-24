export const BaseType = {
  enum: 0x00,
  sint8: 0x01,
  uint8: 0x02,
  sint16: 0x83,
  uint16: 0x84,
  sint32: 0x85,
  uint32: 0x86,
  string: 0x07,
  uint8z: 0x0a,
  uint16z: 0x8b,
  uint32z: 0x8c,
  byte: 0x0d,
} as const;

export interface BaseTypeInfo {
  size: number;
  invalid: number;
  signed: boolean;
}

// Float and 64-bit types are deliberately unsupported: fixtures don't need them.
const INFO: Record<number, BaseTypeInfo> = {
  [BaseType.enum]: { size: 1, invalid: 0xff, signed: false },
  [BaseType.sint8]: { size: 1, invalid: 0x7f, signed: true },
  [BaseType.uint8]: { size: 1, invalid: 0xff, signed: false },
  [BaseType.sint16]: { size: 2, invalid: 0x7fff, signed: true },
  [BaseType.uint16]: { size: 2, invalid: 0xffff, signed: false },
  [BaseType.sint32]: { size: 4, invalid: 0x7fffffff, signed: true },
  [BaseType.uint32]: { size: 4, invalid: 0xffffffff, signed: false },
  [BaseType.string]: { size: 1, invalid: 0x00, signed: false },
  [BaseType.uint8z]: { size: 1, invalid: 0x00, signed: false },
  [BaseType.uint16z]: { size: 2, invalid: 0x0000, signed: false },
  [BaseType.uint32z]: { size: 4, invalid: 0x00000000, signed: false },
  [BaseType.byte]: { size: 1, invalid: 0xff, signed: false },
};

export function baseTypeInfo(baseType: number): BaseTypeInfo {
  const info = INFO[baseType];
  if (info === undefined) throw new Error(`unsupported base type 0x${baseType.toString(16)}`);
  return info;
}

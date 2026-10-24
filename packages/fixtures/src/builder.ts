import { BaseType, baseTypeInfo } from './base-types.js';
import { crc16Bitwise } from './crc.js';

export type Endianness = 'little' | 'big';

export interface FieldSpec {
  num: number;
  baseType: number;
  /** Total size in bytes; defaults to one element of the base type. Larger sizes make array/string fields. */
  size?: number;
}

export interface DevFieldSpec {
  num: number;
  size: number;
  developerDataIndex: number;
  /**
   * How values are encoded. Not written to the definition (the real base type lives in the
   * matching field_description message). Defaults to byte.
   */
  baseType?: number;
}

export interface MessageSchema {
  globalMesgNum: number;
  fields: readonly FieldSpec[];
  /** Present (even if empty) sets the developer-data bit in the definition record header. */
  devFields?: readonly DevFieldSpec[];
}

/** number: integer; number[]: array elements; string: ASCII, NUL-padded; Uint8Array: raw bytes. */
export type FieldValue = number | readonly number[] | string | Uint8Array;
export type FieldValues = Readonly<Record<number, FieldValue | undefined>>;

export interface BuilderOptions {
  headerSize?: 12 | 14;
  protocolVersion?: number;
  profileVersion?: number;
  /** 'zero' stores 0x0000, which the protocol allows to mean "not computed". */
  headerCrc?: 'valid' | 'zero';
}

interface ActiveDefinition {
  schema: MessageSchema;
  endianness: Endianness;
}

/**
 * Assembles FIT files message by message. Validates that data messages match the active
 * definition for their local slot, so fixtures cannot silently be malformed.
 */
export class FitBuilder {
  private readonly body: number[] = [];
  private readonly slots: (ActiveDefinition | undefined)[] = [];

  constructor(private readonly options: BuilderOptions = {}) {}

  get size(): number {
    return this.body.length;
  }

  define(localType: number, schema: MessageSchema, endianness: Endianness = 'little'): this {
    checkRange('local type', localType, 0, 15);
    const hasDev = schema.devFields !== undefined;
    const out = this.body;
    out.push(0x40 | (hasDev ? 0x20 : 0) | localType, 0, endianness === 'big' ? 1 : 0);
    pushUint(out, schema.globalMesgNum, 2, endianness);
    out.push(schema.fields.length);
    for (const f of schema.fields) {
      out.push(f.num, fieldSize(f), f.baseType);
    }
    if (hasDev) {
      const dev = schema.devFields ?? [];
      out.push(dev.length);
      for (const d of dev) out.push(d.num, d.size, d.developerDataIndex);
    }
    this.slots[localType] = { schema, endianness };
    return this;
  }

  /** Data message with a normal record header. */
  data(localType: number, values: FieldValues, devValues: readonly (FieldValue | undefined)[] = []): this {
    checkRange('local type', localType, 0, 15);
    this.body.push(localType);
    this.pushContent(localType, values, devValues);
    return this;
  }

  /** Data message with a compressed timestamp header (local types 0-3 only). */
  compressed(
    localType: number,
    timeOffset: number,
    values: FieldValues,
    devValues: readonly (FieldValue | undefined)[] = [],
  ): this {
    checkRange('compressed local type', localType, 0, 3);
    checkRange('time offset', timeOffset, 0, 31);
    this.body.push(0x80 | (localType << 5) | timeOffset);
    this.pushContent(localType, values, devValues);
    return this;
  }

  /** Appends raw bytes to the record area (for deliberately malformed fixtures). */
  raw(bytes: ArrayLike<number>): this {
    for (let i = 0; i < bytes.length; i++) this.body.push(bytes[i] as number);
    return this;
  }

  build(): Uint8Array {
    const headerSize = this.options.headerSize ?? 14;
    const header: number[] = [headerSize, this.options.protocolVersion ?? 0x20];
    pushUint(header, this.options.profileVersion ?? 21218, 2, 'little');
    pushUint(header, this.body.length, 4, 'little');
    header.push(0x2e, 0x46, 0x49, 0x54); // ".FIT"
    if (headerSize === 14) {
      pushUint(header, this.options.headerCrc === 'zero' ? 0 : crc16Bitwise(header), 2, 'little');
    }
    const out = new Uint8Array(header.length + this.body.length + 2);
    out.set(header, 0);
    out.set(this.body, header.length);
    const crc = crc16Bitwise(out, 0, out.length - 2);
    out[out.length - 2] = crc & 0xff;
    out[out.length - 1] = crc >>> 8;
    return out;
  }

  private pushContent(localType: number, values: FieldValues, devValues: readonly (FieldValue | undefined)[]): void {
    const active = this.slots[localType];
    if (active === undefined) throw new Error(`local type ${localType} has no definition`);
    const { schema, endianness } = active;
    const known = new Set(schema.fields.map((f) => f.num));
    for (const key of Object.keys(values)) {
      if (!known.has(Number(key))) {
        throw new Error(`field ${key} is not in the definition for message ${schema.globalMesgNum}`);
      }
    }
    for (const f of schema.fields) {
      pushValue(this.body, values[f.num], fieldSize(f), f.baseType, endianness);
    }
    const devFields = schema.devFields ?? [];
    if (devValues.length > devFields.length) throw new Error('more developer values than developer fields');
    devFields.forEach((d, i) => pushValue(this.body, devValues[i], d.size, d.baseType ?? BaseType.byte, endianness));
  }
}

function fieldSize(f: FieldSpec): number {
  const size = f.size ?? baseTypeInfo(f.baseType).size;
  if (size % baseTypeInfo(f.baseType).size !== 0) {
    throw new Error(`field ${f.num}: size ${size} is not a multiple of its base type size`);
  }
  return size;
}

function pushValue(
  out: number[],
  value: FieldValue | undefined,
  size: number,
  baseType: number,
  endianness: Endianness,
): void {
  const info = baseTypeInfo(baseType);
  const elements = size / info.size;
  if (typeof value === 'string') {
    if (value.length >= size) throw new Error(`string ${JSON.stringify(value)} does not fit in ${size} bytes`);
    for (let i = 0; i < size; i++) {
      const c = i < value.length ? value.charCodeAt(i) : 0;
      if (c > 0x7f) throw new Error('fixture strings must be ASCII');
      out.push(c);
    }
    return;
  }
  if (value instanceof Uint8Array) {
    if (value.length > size) throw new Error(`byte value of length ${value.length} does not fit in ${size} bytes`);
    for (let i = 0; i < size; i++) out.push(i < value.length ? (value[i] as number) : info.invalid & 0xff);
    return;
  }
  const items: readonly (number | undefined)[] = typeof value === 'number' ? [value] : (value ?? []);
  if (items.length > elements) throw new Error(`${items.length} values do not fit in ${elements} elements`);
  for (let i = 0; i < elements; i++) {
    pushUint(out, toUnsigned(items[i] ?? info.invalid, info.size), info.size, endianness);
  }
}

function toUnsigned(value: number, size: number): number {
  if (!Number.isInteger(value)) throw new Error(`non-integer field value ${value}`);
  const range = 2 ** (8 * size);
  if (value < -range / 2 || value >= range) throw new Error(`value ${value} does not fit in ${size} bytes`);
  return value < 0 ? value + range : value;
}

function pushUint(out: number[], value: number, size: number, endianness: Endianness): void {
  const bytes: number[] = [];
  let v = value;
  for (let i = 0; i < size; i++) {
    bytes.push(v % 256);
    v = Math.floor(v / 256);
  }
  if (endianness === 'big') bytes.reverse();
  out.push(...bytes);
}

function checkRange(what: string, value: number, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${what} ${value} is outside ${min}..${max}`);
  }
}

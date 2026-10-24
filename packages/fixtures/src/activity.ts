import { BaseType } from './base-types.js';
import { type BuilderOptions, type Endianness, FitBuilder, type MessageSchema } from './builder.js';
import { prng, randInt } from './random.js';

export const MesgNum = {
  fileId: 0,
  session: 18,
  lap: 19,
  record: 20,
  event: 21,
  activity: 34,
  gpsMetadata: 160,
  fieldDescription: 206,
  developerDataId: 207,
  timeInZone: 216,
  /** Undocumented; seen alongside gps_metadata on recent Garmin devices. */
  unknown233: 233,
  /** Undocumented; seen alongside gps_metadata on recent Garmin devices. */
  unknown534: 534,
} as const;

export const Sport = { running: 1, cycling: 2, transition: 3, swimming: 5 } as const;

export interface SessionSpec {
  sport: number;
  laps: number;
  /** Nominal lap length; each lap varies by up to ±20%. */
  lapSeconds: number;
}

export interface ActivityOptions {
  seed?: number;
  /** Seconds since the FIT epoch. */
  startTime?: number;
  utcOffsetSeconds?: number;
  sessions?: readonly SessionSpec[];
  recordIntervalSeconds?: number;
  headerSize?: 12 | 14;
  headerCrc?: 'valid' | 'zero';
  endianness?: Endianness;
  /** Write the activity start time as timestamp (253) of every lap/session/activity/time_in_zone (mode A). */
  collapsedTimestamps?: boolean;
  /** Add developer_data_id/field_description and developer fields on records and sessions. */
  developerFields?: boolean;
  /** Use compressed timestamp headers for records where possible. */
  compressedTimestamps?: boolean;
  /** Emit one gps_metadata (160) per record. */
  gpsMetadata?: boolean;
  /** Emit one each of the undocumented messages 233 and 534 per record. */
  unknownMessages?: boolean;
  /** How many local message slots (1-16) the generator may use; fewer slots force redefinitions. */
  localTypes?: number;
}

export interface IntervalTruth {
  messageIndex: number;
  startTime: number;
  /** Correct end time: startTime + round(totalElapsedTimeMs / 1000). */
  endTime: number;
  totalElapsedTimeMs: number;
  /** Value actually stored in field 253 (differs from endTime when collapsed). */
  writtenTimestamp: number;
}

export interface SessionTruth extends IntervalTruth {
  sport: number;
  firstLapIndex: number;
  numLaps: number;
}

export interface ActivityMesgTruth {
  endTime: number;
  writtenTimestamp: number;
  /** Correct local_timestamp: endTime + utcOffsetSeconds. */
  localTimestamp: number;
  writtenLocalTimestamp: number;
  numSessions: number;
  totalTimerTimeMs: number;
}

export interface TimeInZoneTruth {
  referenceMesg: number;
  referenceIndex: number;
  endTime: number;
  writtenTimestamp: number;
}

export interface ActivityTruth {
  options: Required<Omit<ActivityOptions, 'sessions'>> & { sessions: readonly SessionSpec[] };
  startTime: number;
  endTime: number;
  utcOffsetSeconds: number;
  laps: IntervalTruth[];
  sessions: SessionTruth[];
  activity: ActivityMesgTruth;
  timeInZone: TimeInZoneTruth[];
  recordTimestamps: number[];
  /** Data message count per global message number. */
  dataMessageCounts: Record<number, number>;
  definitionCount: number;
  compressedCount: number;
  /** Laps + sessions whose written timestamp is earlier than their start_time. */
  endBeforeStartCount: number;
}

export interface GeneratedFit {
  bytes: Uint8Array;
  truth: ActivityTruth;
}

const DEFAULTS = {
  seed: 1,
  startTime: 1_100_000_000,
  utcOffsetSeconds: 9 * 3600,
  sessions: [{ sport: Sport.running, laps: 3, lapSeconds: 120 }] as readonly SessionSpec[],
  recordIntervalSeconds: 5,
  headerSize: 14 as 12 | 14,
  headerCrc: 'valid' as 'valid' | 'zero',
  endianness: 'little' as Endianness,
  collapsedTimestamps: false,
  developerFields: false,
  compressedTimestamps: false,
  gpsMetadata: false,
  unknownMessages: false,
  localTypes: 16,
};

const u8 = BaseType.uint8;
const u16 = BaseType.uint16;
const u32 = BaseType.uint32;
const en = BaseType.enum;

const ZONES = 5;

const SCHEMAS = {
  fileId: {
    globalMesgNum: MesgNum.fileId,
    fields: [
      { num: 0, baseType: en }, // type
      { num: 1, baseType: u16 }, // manufacturer
      { num: 2, baseType: u16 }, // product
      { num: 3, baseType: BaseType.uint32z }, // serial_number
      { num: 4, baseType: u32 }, // time_created
    ],
  },
  developerDataId: {
    globalMesgNum: MesgNum.developerDataId,
    fields: [
      { num: 1, baseType: BaseType.byte, size: 16 }, // application_id
      { num: 3, baseType: u8 }, // developer_data_index
      { num: 4, baseType: u32 }, // application_version
    ],
  },
  fieldDescription: {
    globalMesgNum: MesgNum.fieldDescription,
    fields: [
      { num: 0, baseType: u8 }, // developer_data_index
      { num: 1, baseType: u8 }, // field_definition_number
      { num: 2, baseType: u8 }, // fit_base_type_id
      { num: 3, baseType: BaseType.string, size: 16 }, // field_name
      { num: 8, baseType: BaseType.string, size: 8 }, // units
      { num: 14, baseType: u16 }, // native_mesg_num
    ],
  },
  event: {
    globalMesgNum: MesgNum.event,
    fields: [
      { num: 253, baseType: u32 },
      { num: 0, baseType: en }, // event
      { num: 1, baseType: en }, // event_type
    ],
  },
  lap: {
    globalMesgNum: MesgNum.lap,
    fields: [
      { num: 254, baseType: u16 }, // message_index
      { num: 253, baseType: u32 }, // timestamp
      { num: 0, baseType: en }, // event
      { num: 1, baseType: en }, // event_type
      { num: 2, baseType: u32 }, // start_time
      { num: 7, baseType: u32 }, // total_elapsed_time (ms)
      { num: 8, baseType: u32 }, // total_timer_time (ms)
    ],
  },
  session: {
    globalMesgNum: MesgNum.session,
    fields: [
      { num: 254, baseType: u16 },
      { num: 253, baseType: u32 },
      { num: 0, baseType: en },
      { num: 1, baseType: en },
      { num: 2, baseType: u32 },
      { num: 5, baseType: en }, // sport
      { num: 6, baseType: en }, // sub_sport
      { num: 7, baseType: u32 },
      { num: 8, baseType: u32 },
      { num: 25, baseType: u16 }, // first_lap_index
      { num: 26, baseType: u16 }, // num_laps
    ],
  },
  activity: {
    globalMesgNum: MesgNum.activity,
    fields: [
      { num: 253, baseType: u32 },
      { num: 0, baseType: u32 }, // total_timer_time (ms)
      { num: 1, baseType: u16 }, // num_sessions
      { num: 2, baseType: en }, // type
      { num: 3, baseType: en }, // event
      { num: 4, baseType: en }, // event_type
      { num: 5, baseType: u32 }, // local_timestamp
    ],
  },
  timeInZone: {
    globalMesgNum: MesgNum.timeInZone,
    fields: [
      { num: 253, baseType: u32 },
      { num: 0, baseType: u16 }, // reference_mesg
      { num: 1, baseType: u16 }, // reference_index
      { num: 2, baseType: u32, size: 4 * ZONES }, // time_in_hr_zone (ms)
    ],
  },
  record: {
    globalMesgNum: MesgNum.record,
    fields: [
      { num: 253, baseType: u32 },
      { num: 3, baseType: u8 }, // heart_rate
      { num: 5, baseType: u32 }, // distance (cm)
    ],
  },
  recordCompressed: {
    globalMesgNum: MesgNum.record,
    fields: [
      { num: 3, baseType: u8 },
      { num: 5, baseType: u32 },
    ],
  },
  gpsMetadata: {
    // Positions are deliberately omitted: fixtures carry no coordinates.
    globalMesgNum: MesgNum.gpsMetadata,
    fields: [
      { num: 253, baseType: u32 },
      { num: 0, baseType: u16 }, // timestamp_ms
      { num: 4, baseType: u32 }, // enhanced_speed
    ],
  },
  unknown233: {
    globalMesgNum: MesgNum.unknown233,
    fields: [
      { num: 0, baseType: u32 },
      { num: 1, baseType: u16 },
      { num: 2, baseType: BaseType.byte, size: 6 },
    ],
  },
  unknown534: {
    globalMesgNum: MesgNum.unknown534,
    fields: [
      { num: 0, baseType: u8 },
      { num: 1, baseType: u32 },
    ],
  },
} satisfies Record<string, MessageSchema>;

type SchemaKey = keyof typeof SCHEMAS;

// Developer fields: two on records, one on sessions.
const DEV_FIELDS = [
  { num: 0, name: 'power2', units: 'W', baseType: u16, size: 2, nativeMesg: MesgNum.record },
  { num: 1, name: 'cadence2', units: 'rpm', baseType: u8, size: 1, nativeMesg: MesgNum.record },
  { num: 2, name: 'work', units: 'kJ', baseType: u32, size: 4, nativeMesg: MesgNum.session },
] as const;

function withDevFields(schema: MessageSchema, nativeMesg: number): MessageSchema {
  return {
    ...schema,
    devFields: DEV_FIELDS.filter((d) => d.nativeMesg === nativeMesg).map((d) => ({
      num: d.num,
      size: d.size,
      developerDataIndex: 0,
      baseType: d.baseType,
    })),
  };
}

/** Least-recently-used assignment of message schemas to local slots, emitting definitions as needed. */
class SlotAllocator {
  private readonly holders: (string | undefined)[] = [];
  private readonly lastUse: number[] = [];
  private clock = 0;
  definitionCount = 0;

  constructor(
    private readonly builder: FitBuilder,
    private readonly slotCount: number,
    private readonly endianness: Endianness,
    private readonly reservedSlot: number | null,
  ) {}

  use(key: string, schema: MessageSchema, fixedSlot?: number): number {
    let slot = fixedSlot ?? this.holders.findIndex((h) => h === key);
    if (slot < 0 || this.holders[slot] !== key) {
      if (fixedSlot === undefined) slot = this.pickSlot();
      this.builder.define(slot, schema, this.endianness);
      this.holders[slot] = key;
      this.definitionCount++;
    }
    this.lastUse[slot] = ++this.clock;
    return slot;
  }

  private pickSlot(): number {
    let best = -1;
    for (let s = 0; s < this.slotCount; s++) {
      if (s === this.reservedSlot) continue;
      if (this.holders[s] === undefined) return s;
      if (best < 0 || (this.lastUse[s] ?? 0) < (this.lastUse[best] ?? 0)) best = s;
    }
    return best;
  }
}

/**
 * Generates a deterministic synthetic activity FIT file plus the ground truth it encodes.
 * Contains no real-world data and no coordinates.
 */
export function generateActivity(options: ActivityOptions = {}): GeneratedFit {
  const opts = { ...DEFAULTS, ...stripUndefined(options) };
  if (opts.localTypes < 1 || opts.localTypes > 16) throw new RangeError('localTypes must be 1..16');
  if (opts.compressedTimestamps && opts.localTypes < 2) {
    throw new RangeError('compressed timestamps need at least 2 local types (slot 0 is reserved)');
  }
  const rand = prng(opts.seed);
  const builderOptions: BuilderOptions = {
    headerSize: opts.headerSize,
    headerCrc: opts.headerCrc,
  };
  const builder = new FitBuilder(builderOptions);
  const slots = new SlotAllocator(builder, opts.localTypes, opts.endianness, opts.compressedTimestamps ? 0 : null);

  const dataMessageCounts: Record<number, number> = {};
  let compressedCount = 0;
  let referenceTimestamp: number | null = null; // last full timestamp seen by a decoder

  const schemaFor = (key: SchemaKey): MessageSchema => {
    const base = SCHEMAS[key];
    if (!opts.developerFields) return base;
    if (key === 'record' || key === 'recordCompressed') return withDevFields(base, MesgNum.record);
    if (key === 'session') return withDevFields(base, MesgNum.session);
    return base;
  };

  const emit = (key: SchemaKey, values: Record<number, number | number[] | string | Uint8Array>, dev: number[] = []) => {
    const schema = schemaFor(key);
    const slot = slots.use(key, schema);
    builder.data(slot, values, dev);
    dataMessageCounts[schema.globalMesgNum] = (dataMessageCounts[schema.globalMesgNum] ?? 0) + 1;
    const ts = values[253];
    if (typeof ts === 'number') referenceTimestamp = ts;
  };

  const start = opts.startTime;
  const collapsedTs = start;

  emit('fileId', { 0: 4, 1: 1, 2: 4315, 3: 3_000_000_000 + randInt(rand, 0, 999_999), 4: start });

  if (opts.developerFields) {
    emit('developerDataId', { 1: Uint8Array.from({ length: 16 }, (_, i) => (i * 17 + 3) & 0xff), 3: 0, 4: 100 });
    for (const d of DEV_FIELDS) {
      emit('fieldDescription', { 0: 0, 1: d.num, 2: d.baseType, 3: d.name, 8: d.units, 14: d.nativeMesg });
    }
  }

  emit('event', { 253: start, 0: 0, 1: 0 }); // timer start

  const laps: IntervalTruth[] = [];
  const sessions: SessionTruth[] = [];
  const timeInZone: TimeInZoneTruth[] = [];
  const recordTimestamps: number[] = [];
  let t = start;
  let distanceCm = 0;

  const writeTimeInZone = (referenceMesg: number, referenceIndex: number, endTime: number, elapsedMs: number) => {
    const writtenTimestamp = opts.collapsedTimestamps ? collapsedTs : endTime;
    const zones = splitInto(elapsedMs, ZONES, rand);
    emit('timeInZone', { 253: writtenTimestamp, 0: referenceMesg, 1: referenceIndex, 2: zones });
    timeInZone.push({ referenceMesg, referenceIndex, endTime, writtenTimestamp });
  };

  for (const [sessionIndex, spec] of opts.sessions.entries()) {
    const sessionStart = t;
    const firstLapIndex = laps.length;
    for (let l = 0; l < spec.laps; l++) {
      const lapStart = t;
      const duration = Math.max(1, Math.round(spec.lapSeconds * (0.8 + 0.4 * rand())));
      const lapEnd = lapStart + duration;

      for (let ts = lapStart; ts < lapEnd; ts += opts.recordIntervalSeconds) {
        const hr = randInt(rand, 90, 180);
        distanceCm += randInt(rand, 0, 500) * opts.recordIntervalSeconds;
        const dev = opts.developerFields ? [randInt(rand, 100, 400), randInt(rand, 60, 100)] : [];
        const delta = referenceTimestamp === null ? -1 : ts - referenceTimestamp;
        // The first record of each lap always carries a full timestamp, like real devices.
        if (opts.compressedTimestamps && ts !== lapStart && delta >= 0 && delta < 32) {
          const schema = schemaFor('recordCompressed');
          slots.use('recordCompressed', schema, 0);
          builder.compressed(0, ts & 0x1f, { 3: hr, 5: distanceCm }, dev);
          dataMessageCounts[MesgNum.record] = (dataMessageCounts[MesgNum.record] ?? 0) + 1;
          compressedCount++;
          referenceTimestamp = ts;
        } else {
          emit('record', { 253: ts, 3: hr, 5: distanceCm }, dev);
        }
        recordTimestamps.push(ts);

        if (opts.gpsMetadata) emit('gpsMetadata', { 253: ts, 0: randInt(rand, 0, 999), 4: randInt(rand, 0, 6000) });
        if (opts.unknownMessages) {
          emit('unknown233', {
            0: randInt(rand, 0, 0xfffffffe),
            1: randInt(rand, 0, 0xfffe),
            2: Uint8Array.from({ length: 6 }, () => randInt(rand, 0, 254)),
          });
          emit('unknown534', { 0: randInt(rand, 0, 254), 1: randInt(rand, 0, 0xfffffffe) });
        }
      }

      const elapsedMs = duration * 1000 + randInt(rand, -499, 499);
      const messageIndex = laps.length;
      const writtenTimestamp = opts.collapsedTimestamps ? collapsedTs : lapEnd;
      writeTimeInZone(MesgNum.lap, messageIndex, lapEnd, elapsedMs);
      emit('lap', { 254: messageIndex, 253: writtenTimestamp, 0: 9, 1: 1, 2: lapStart, 7: elapsedMs, 8: elapsedMs });
      laps.push({ messageIndex, startTime: lapStart, endTime: lapEnd, totalElapsedTimeMs: elapsedMs, writtenTimestamp });
      t = lapEnd;
    }

    // Session ends with its last lap. Summing per-lap jitter could drift past a whole second,
    // so the session gets its own sub-second jitter instead.
    const sessionEnd = t;
    const sessionElapsedMs = (sessionEnd - sessionStart) * 1000 + randInt(rand, -499, 499);
    const writtenTimestamp = opts.collapsedTimestamps ? collapsedTs : sessionEnd;
    writeTimeInZone(MesgNum.session, sessionIndex, sessionEnd, sessionElapsedMs);
    emit(
      'session',
      {
        254: sessionIndex,
        253: writtenTimestamp,
        0: 8,
        1: 1,
        2: sessionStart,
        5: spec.sport,
        6: 0,
        7: sessionElapsedMs,
        8: sessionElapsedMs,
        25: firstLapIndex,
        26: spec.laps,
      },
      opts.developerFields ? [randInt(rand, 100, 5000)] : [],
    );
    sessions.push({
      messageIndex: sessionIndex,
      startTime: sessionStart,
      endTime: sessionEnd,
      totalElapsedTimeMs: sessionElapsedMs,
      writtenTimestamp,
      sport: spec.sport,
      firstLapIndex,
      numLaps: spec.laps,
    });
  }

  const end = Math.max(...sessions.map((s) => s.endTime));
  emit('event', { 253: end, 0: 0, 1: 4 }); // timer stop_all

  const totalTimerTimeMs = sessions.reduce((sum, s) => sum + s.totalElapsedTimeMs, 0);
  const activityWritten = opts.collapsedTimestamps ? collapsedTs : end;
  const activity: ActivityMesgTruth = {
    endTime: end,
    writtenTimestamp: activityWritten,
    localTimestamp: end + opts.utcOffsetSeconds,
    writtenLocalTimestamp: activityWritten + opts.utcOffsetSeconds,
    numSessions: sessions.length,
    totalTimerTimeMs,
  };
  emit('activity', {
    253: activity.writtenTimestamp,
    0: totalTimerTimeMs,
    1: sessions.length,
    2: 0,
    3: 26,
    4: 1,
    5: activity.writtenLocalTimestamp,
  });

  const endBeforeStartCount = [...laps, ...sessions].filter((x) => x.writtenTimestamp < x.startTime).length;

  return {
    bytes: builder.build(),
    truth: {
      options: opts,
      startTime: start,
      endTime: end,
      utcOffsetSeconds: opts.utcOffsetSeconds,
      laps,
      sessions,
      activity,
      timeInZone,
      recordTimestamps,
      dataMessageCounts,
      definitionCount: slots.definitionCount,
      compressedCount,
      endBeforeStartCount,
    },
  };
}

/** Splits `total` into `parts` non-negative integers that sum to `total`. */
function splitInto(total: number, parts: number, rand: () => number): number[] {
  const weights = Array.from({ length: parts }, () => rand() + 0.01);
  const sum = weights.reduce((a, b) => a + b, 0);
  const out = weights.map((w) => Math.floor((total * w) / sum));
  out[parts - 1] = (out[parts - 1] as number) + total - out.reduce((a, b) => a + b, 0);
  return out;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

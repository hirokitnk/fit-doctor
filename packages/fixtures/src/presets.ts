import { type ActivityOptions, type GeneratedFit, Sport, generateActivity } from './activity.js';

/**
 * Scaled-down version of the real failure case from the spec: a 5-session triathlon with
 * 86 laps and 91 time_in_zone messages (86 laps + 5 sessions).
 */
export const TRIATHLON_SESSIONS = [
  { sport: Sport.swimming, laps: 10, lapSeconds: 40 },
  { sport: Sport.transition, laps: 1, lapSeconds: 30 },
  { sport: Sport.cycling, laps: 40, lapSeconds: 40 },
  { sport: Sport.transition, laps: 1, lapSeconds: 30 },
  { sport: Sport.running, laps: 34, lapSeconds: 40 },
] as const;

export const PRESET_OPTIONS = {
  /** Clean single-sport activity; nothing to repair. */
  normal: {},
  /** Mode A: every summary timestamp collapsed to the activity start. */
  collapsedTimestamps: { collapsedTimestamps: true },
  /** Mode A at real-world shape, with mode-B payloads and a JST offset. */
  triathlonCollapsed: {
    sessions: TRIATHLON_SESSIONS,
    recordIntervalSeconds: 10,
    collapsedTimestamps: true,
    gpsMetadata: true,
    unknownMessages: true,
    developerFields: true,
    utcOffsetSeconds: 9 * 3600,
  },
  developerFields: { developerFields: true },
  bigEndian: { endianness: 'big', utcOffsetSeconds: -7 * 3600 },
  header12: { headerSize: 12 },
  headerCrcZero: { headerCrc: 'zero' },
  compressedTimestamps: { compressedTimestamps: true },
  /** Mode B: payloads that were removed to get a real file accepted. */
  modeB: { gpsMetadata: true, unknownMessages: true, developerFields: true },
  /** Few local slots, so definitions are constantly redefined. */
  localTypeReuse: { localTypes: 2, gpsMetadata: true, unknownMessages: true, developerFields: true },
  /** Every option at once. */
  everything: {
    headerSize: 12,
    endianness: 'big',
    collapsedTimestamps: true,
    developerFields: true,
    compressedTimestamps: true,
    gpsMetadata: true,
    unknownMessages: true,
    localTypes: 3,
    sessions: [
      { sport: Sport.cycling, laps: 2, lapSeconds: 90 },
      { sport: Sport.running, laps: 2, lapSeconds: 90 },
    ],
  },
} satisfies Record<string, ActivityOptions>;

export type PresetName = keyof typeof PRESET_OPTIONS;

export const PRESET_NAMES = Object.keys(PRESET_OPTIONS) as PresetName[];

export function preset(name: PresetName): GeneratedFit {
  return generateActivity(PRESET_OPTIONS[name] as ActivityOptions);
}

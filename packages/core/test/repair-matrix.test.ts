import { MesgNum, PRESET_NAMES, preset } from '@fit-doctor/fixtures';
import { sdkCanDecode, sdkCheck } from '@fit-doctor/fixtures/sdk';
import { describe, expect, it } from 'vitest';
import { diagnose } from '../src/diagnose.js';
import { repairTimestamps } from '../src/repair-timestamps.js';
import { stripDeveloperFields, stripMessages } from '../src/strip.js';

type Op = { name: string; run: (b: Uint8Array) => Uint8Array };

const OPS: Op[] = [
  { name: 'timestamps', run: (b) => repairTimestamps(b).bytes },
  { name: 'gps_metadata', run: (b) => stripMessages(b, [MesgNum.gpsMetadata]).bytes },
  { name: 'unknown', run: (b) => stripMessages(b, [MesgNum.unknown233, MesgNum.unknown534]).bytes },
  { name: 'developer', run: (b) => stripDeveloperFields(b).bytes },
];

/** All non-empty subsets of OPS. */
const SUBSETS = Array.from({ length: (1 << OPS.length) - 1 }, (_, i) => OPS.filter((_, j) => ((i + 1) >> j) & 1));

describe.each(PRESET_NAMES)('repair matrix: %s', (name) => {
  const { bytes, truth } = preset(name);

  it.each(SUBSETS.map((ops) => [ops.map((o) => o.name).join(' + '), ops] as const))(
    '%s: valid for the SDK and independent of order',
    (_, ops) => {
      const forward = ops.reduce((b, op) => op.run(b), bytes);
      const backward = [...ops].reverse().reduce((b, op) => op.run(b), bytes);
      expect(backward).toEqual(forward);

      const d = diagnose(forward);
      expect(d.structure.ok).toBe(true);
      expect(d.crc.file).toBe('valid');
      // 0x0000 survives untouched files; any rewrite stores the real header CRC.
      expect(d.crc.header).not.toBe('invalid');

      const sdk = sdkCheck(forward);
      expect(sdk.isFIT).toBe(true);
      expect(sdk.integrity).toBe(true);
      if (sdkCanDecode(truth.compressedCount)) expect(sdk.errors).toEqual([]);
    },
  );
});

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { diagnose, repairTimestamps, stripDeveloperFields, stripMessages } from '@fit-doctor/core';
import { BaseType, FitBuilder, MesgNum, preset } from '@fit-doctor/fixtures';
import { sdkCheck } from '@fit-doctor/fixtures/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT_FAILURE, EXIT_OK, EXIT_PROBLEMS, defaultOutputPath, main } from '../src/cli.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fit-doctor-cli-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(...argv: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = main(argv, { stdout: (t) => stdout.push(t), stderr: (t) => stderr.push(t) });
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

function write(name: string, bytes: Uint8Array): string {
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
}

const read = (path: string) => new Uint8Array(readFileSync(path));

describe('general', () => {
  it('prints usage and version', () => {
    expect(run('--help')).toMatchObject({ code: EXIT_OK });
    expect(run('--help').stdout).toContain('fit-doctor repair <file.fit>');
    expect(run().code).toBe(EXIT_FAILURE);
    expect(run('--version').stdout).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('rejects unknown commands and options', () => {
    expect(run('frob')).toMatchObject({ code: EXIT_FAILURE, stderr: expect.stringContaining('unknown command') });
    expect(run('diagnose', 'a.fit', '--bogus')).toMatchObject({ code: EXIT_FAILURE, stderr: expect.stringContaining('--bogus') });
    expect(run('diagnose')).toMatchObject({ code: EXIT_FAILURE, stderr: expect.stringContaining('exactly one input file') });
    expect(run('diagnose', join(dir, 'missing.fit'))).toMatchObject({ code: EXIT_FAILURE, stderr: expect.stringContaining('cannot read') });
  });

  it('derives the default output name', () => {
    expect(defaultOutputPath('/a/b/ride.fit')).toBe('/a/b/ride_repaired.fit');
    expect(defaultOutputPath('/a/b/RIDE.FIT')).toBe('/a/b/RIDE_repaired.fit');
    expect(defaultOutputPath('ride')).toBe('ride_repaired.fit');
  });
});

describe('diagnose', () => {
  it('exits 0 for a clean file', () => {
    const r = run('diagnose', write('normal.fit', preset('normal').bytes));
    expect(r.code).toBe(EXIT_OK);
    expect(r.stdout).toContain('Structure  OK');
    expect(r.stdout).toMatch(/Findings\n {2}none/);
  });

  it('exits 1 and reports both counts for mode A', () => {
    const r = run('diagnose', write('tri.fit', preset('triathlonCollapsed').bytes));
    expect(r.code).toBe(EXIT_PROBLEMS);
    expect(r.stdout).toMatch(/lap\s+86\s+0\s+85\s+1\s+0\s+0/);
    expect(r.stdout).toMatch(/time_in_zone\s+91\s+0\s+89\s+2\s+0\s+0\s+0/);
    expect(r.stdout).toContain('178 summary end times are earlier than their start');
    expect(r.stdout).toContain('4 summary end times equal their start');
    expect(r.stdout).toContain('UTC offset +09:00');
    expect(r.stdout).toMatch(/summary timestamps\s+0:00:00/);
    expect(r.stdout).toMatch(/233\s+\(undefined\)/);
  });

  it('emits the core Diagnosis as JSON', () => {
    const { bytes } = preset('modeB');
    const r = run('diagnose', write('b.fit', bytes), '--json');
    expect(JSON.parse(r.stdout)).toEqual(JSON.parse(JSON.stringify({ file: join(dir, 'b.fit'), diagnosis: diagnose(bytes) })));
  });

  it('reports broken files without crashing', () => {
    const { bytes } = preset('normal');
    const r = run('diagnose', write('cut.fit', bytes.subarray(0, bytes.length - 50)));
    expect(r.code).toBe(EXIT_PROBLEMS);
    expect(r.stdout).toContain('Structure  BROKEN');
    expect(run('diagnose', write('junk.fit', Uint8Array.of(1, 2, 3))).stdout).toContain('Header     invalid');
  });
});

describe('repair', () => {
  it('repairs timestamps by default and writes <name>_repaired.fit', () => {
    const { bytes } = preset('triathlonCollapsed');
    const input = write('tri.fit', bytes);
    const r = run('repair', input);
    expect(r.code).toBe(EXIT_OK);
    expect(r.stdout).toContain('repaired 178 end<start and 4 zero-duration (laps 85 + 1, sessions 4 + 1, time_in_zone 89 + 2)');
    expect(r.stdout).toContain('Re-check: no errors or warnings.');
    const output = join(dir, 'tri_repaired.fit');
    expect(read(output)).toEqual(repairTimestamps(bytes).bytes);
    expect(read(input)).toEqual(bytes);
  });

  it('refuses to overwrite unless forced, and never overwrites the input', () => {
    const input = write('tri.fit', preset('collapsedTimestamps').bytes);
    const output = write('tri_repaired.fit', Uint8Array.of(0));
    expect(run('repair', input)).toMatchObject({ code: EXIT_FAILURE, stderr: expect.stringContaining('already exists') });
    expect(read(output)).toEqual(Uint8Array.of(0));
    expect(run('repair', input, '--force').code).toBe(EXIT_OK);
    expect(read(output).length).toBeGreaterThan(1);
    expect(run('repair', input, '-o', input, '--force')).toMatchObject({
      code: EXIT_FAILURE,
      stderr: expect.stringContaining('refusing to overwrite the input'),
    });
  });

  it('does not write anything on --dry-run or when nothing changes', () => {
    const tri = write('tri.fit', preset('collapsedTimestamps').bytes);
    const dry = run('repair', tri, '--dry-run');
    expect(dry.stdout).toContain('Dry run: would write');
    expect(existsSync(join(dir, 'tri_repaired.fit'))).toBe(false);

    const clean = run('repair', write('normal.fit', preset('normal').bytes));
    expect(clean.stdout).toContain('timestamps: nothing to repair');
    expect(clean.stdout).toContain('Nothing to change; no file written.');
    expect(existsSync(join(dir, 'normal_repaired.fit'))).toBe(false);
  });

  it('applies --strip-all exactly like the core functions', () => {
    const { bytes } = preset('triathlonCollapsed');
    const output = join(dir, 'out.fit');
    const r = run('repair', write('tri.fit', bytes), '--strip-all', '-o', output);
    expect(r.code).toBe(EXIT_OK);
    const expected = stripDeveloperFields(
      stripMessages(stripMessages(repairTimestamps(bytes).bytes, [MesgNum.gpsMetadata]).bytes, [233, 534]).bytes,
    ).bytes;
    expect(read(output)).toEqual(expected);
    const sdk = sdkCheck(read(output));
    expect(sdk.integrity).toBe(true);
    expect(sdk.errors).toEqual([]);
    expect(diagnose(read(output)).findings).toEqual([]);
  });

  it('supports trying mode-B removals one at a time', () => {
    const { bytes } = preset('modeB');
    const input = write('b.fit', bytes);
    const gps = join(dir, 'gps.fit');
    run('repair', input, '--no-timestamps', '--strip-gps-metadata', '-o', gps);
    expect(read(gps)).toEqual(stripMessages(bytes, [MesgNum.gpsMetadata]).bytes);
    expect(diagnose(read(gps)).unknownMesgNums).toEqual([233, 534]);

    const custom = join(dir, 'custom.fit');
    const r = run('repair', input, '--no-timestamps', '--strip', '233', '--strip', '534, 160', '-o', custom);
    expect(r.stdout).toContain('strip 233,534,160');
    expect(read(custom)).toEqual(stripMessages(bytes, [233, 534, 160]).bytes);

    expect(run('repair', input, '--strip', '70000')).toMatchObject({ code: EXIT_FAILURE });
  });

  it('emits a JSON report', () => {
    const { bytes } = preset('triathlonCollapsed');
    const r = run('repair', write('tri.fit', bytes), '--strip-developer', '--json');
    const json = JSON.parse(r.stdout);
    expect(json.written).toBe(true);
    expect(json.output).toBe(join(dir, 'tri_repaired.fit'));
    expect(json.steps.map((s: { name: string }) => s.name)).toEqual(['timestamps', 'strip-developer']);
    expect(json.steps[0].report.totals).toEqual({ endBeforeStart: 178, zeroDuration: 4 });
    expect(json.after.timestamps.collapsedSuspected).toBe(false);
    expect(json.before.timestamps.collapsedSuspected).toBe(true);
  });

  it('warns when compressed timestamps would decode differently', () => {
    const T0 = 1_000_000_000;
    const ts = (num: number) => ({ globalMesgNum: num, fields: [{ num: 253, baseType: BaseType.uint32 }] });
    const bytes = new FitBuilder()
      .define(0, ts(MesgNum.record))
      .data(0, { 253: T0 })
      .define(1, ts(MesgNum.gpsMetadata))
      .data(1, { 253: T0 + 40 })
      .define(2, { globalMesgNum: MesgNum.record, fields: [{ num: 3, baseType: BaseType.uint8 }] })
      .compressed(2, (T0 + 45) & 0x1f, { 3: 1 })
      .build();
    const r = run('repair', write('c.fit', bytes), '--strip-gps-metadata', '--dry-run');
    expect(r.stdout).toContain('! warning: 1 compressed-timestamp records now decode to a different time');
  });

  it('refuses structurally broken files', () => {
    const { bytes } = preset('collapsedTimestamps');
    const r = run('repair', write('cut.fit', bytes.subarray(0, 300)));
    expect(r.code).toBe(EXIT_FAILURE);
    expect(r.stderr).toContain('cannot repair');
    expect(existsSync(join(dir, 'cut_repaired.fit'))).toBe(false);
  });
});

describe('built binary', () => {
  const bin = fileURLToPath(new URL('../dist/bin.js', import.meta.url));

  it('runs end to end via node', () => {
    const { bytes } = preset('triathlonCollapsed');
    const input = write('tri.fit', bytes);
    const diag = spawnSync(process.execPath, [bin, 'diagnose', input], { encoding: 'utf8' });
    expect(diag.status).toBe(EXIT_PROBLEMS);
    expect(diag.stdout).toContain('178 summary end times');

    const rep = spawnSync(process.execPath, [bin, 'repair', input, '--strip-all'], { encoding: 'utf8' });
    expect(rep.stderr).toBe('');
    expect(rep.status).toBe(EXIT_OK);
    const after = spawnSync(process.execPath, [bin, 'diagnose', join(dir, 'tri_repaired.fit')], { encoding: 'utf8' });
    expect(after.status).toBe(EXIT_OK);
  });
});

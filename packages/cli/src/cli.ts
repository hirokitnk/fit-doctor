import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { type ParseArgsOptionsConfig, parseArgs } from 'node:util';
import {
  type Diagnosis,
  FitStructureError,
  type RepairResult,
  diagnose,
  repairTimestamps,
  stripDeveloperFields,
  stripMessages,
} from '@fit-doctor/core';
import { describeFinding, formatBytes, formatDiagnosis, formatStrip, formatTimestampRepair } from './format.js';

export interface Io {
  stdout(text: string): void;
  stderr(text: string): void;
}

export const nodeIo: Io = {
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(`${text}\n`),
};

export const VERSION = '0.0.0';

const MESG_GPS_METADATA = 160;

/** Exit codes: 0 ok, 1 diagnose found errors, 2 usage / I/O / unrepairable input. */
export const EXIT_OK = 0;
export const EXIT_PROBLEMS = 1;
export const EXIT_FAILURE = 2;

const USAGE = `Usage:
  fit-doctor diagnose <file.fit> [--json]
  fit-doctor repair <file.fit> [options]

Diagnose and repair FIT files that Garmin Connect refuses to import. Files are modified
in place at the byte level; nothing is decoded and re-encoded.

repair options:
  -o, --output <path>      Output file (default: <name>_repaired.fit next to the input)
      --no-timestamps      Do not repair collapsed lap/session/activity/time_in_zone end times
      --strip-gps-metadata Remove gps_metadata (160) messages
      --strip-unknown      Remove messages whose numbers the public FIT profile does not define
      --strip-developer    Remove Connect IQ developer fields and their descriptions
      --strip-all          All three --strip-* options above
      --strip <n[,n...]>   Remove messages with these global message numbers (repeatable)
      --dry-run            Report what would change without writing a file
  -f, --force              Overwrite the output file if it exists
      --json               Machine-readable output

Which --strip-* option makes Garmin Connect accept a file is not known; try them one at a time.

Exit status: 0 success, 1 diagnose found errors, 2 failure.`;

export function main(argv: string[], io: Io = nodeIo): number {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case 'diagnose':
        return diagnoseCommand(rest, io);
      case 'repair':
        return repairCommand(rest, io);
      case '-v':
      case '--version':
        io.stdout(VERSION);
        return EXIT_OK;
      case undefined:
      case '-h':
      case '--help':
      case 'help':
        io.stdout(USAGE);
        return command === undefined ? EXIT_FAILURE : EXIT_OK;
      default:
        io.stderr(`fit-doctor: unknown command "${command}"\n\n${USAGE}`);
        return EXIT_FAILURE;
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`fit-doctor: ${error.message}\n\n${USAGE}`);
      return EXIT_FAILURE;
    }
    if (error instanceof CliError) {
      io.stderr(`fit-doctor: ${error.message}`);
      return EXIT_FAILURE;
    }
    throw error;
  }
}

class UsageError extends Error {}
class CliError extends Error {}

function parse<O extends ParseArgsOptionsConfig>(args: string[], options: O) {
  try {
    return parseArgs({ args, options, allowPositionals: true, allowNegative: true, strict: true });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
}

function singleFile(positionals: string[]): string {
  if (positionals.length !== 1) throw new UsageError('expected exactly one input file');
  return positionals[0] as string;
}

function readInput(file: string): Uint8Array {
  try {
    const buf = readFileSync(file);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  } catch (error) {
    throw new CliError(`cannot read ${file}: ${(error as Error).message}`);
  }
}

function hasErrors(d: Diagnosis): boolean {
  return d.findings.some((f) => f.severity === 'error');
}

function diagnoseCommand(args: string[], io: Io): number {
  const { values, positionals } = parse(args, { json: { type: 'boolean' } });
  const file = singleFile(positionals);
  const d = diagnose(readInput(file));
  io.stdout(values.json ? JSON.stringify({ file, diagnosis: d }, null, 2) : formatDiagnosis(file, d));
  return hasErrors(d) ? EXIT_PROBLEMS : EXIT_OK;
}

export function defaultOutputPath(input: string): string {
  const ext = extname(input);
  const stem = ext.toLowerCase() === '.fit' ? basename(input, ext) : basename(input);
  return join(dirname(input), `${stem}_repaired.fit`);
}

function parseMesgNums(lists: string[]): number[] {
  const nums = lists.flatMap((l) => l.split(',')).map((s) => s.trim()).filter((s) => s !== '');
  return nums.map((s) => {
    const v = Number(s);
    if (!/^\d+$/.test(s) || v > 0xffff) throw new UsageError(`--strip expects message numbers 0-65535, got "${s}"`);
    return v;
  });
}

interface Step {
  name: string;
  changed: boolean;
  report: unknown;
  lines: string[];
  compressedTimestampsChanged: number;
}

function repairCommand(args: string[], io: Io): number {
  const { values, positionals } = parse(args, {
    output: { type: 'string', short: 'o' },
    timestamps: { type: 'boolean', default: true },
    'strip-gps-metadata': { type: 'boolean' },
    'strip-unknown': { type: 'boolean' },
    'strip-developer': { type: 'boolean' },
    'strip-all': { type: 'boolean' },
    strip: { type: 'string', multiple: true },
    'dry-run': { type: 'boolean' },
    force: { type: 'boolean', short: 'f' },
    json: { type: 'boolean' },
  });
  const input = singleFile(positionals);
  const output = (values.output as string | undefined) ?? defaultOutputPath(input);
  const dryRun = values['dry-run'] === true;
  const all = values['strip-all'] === true;
  const custom = parseMesgNums((values.strip as string[] | undefined) ?? []);

  if (resolve(output) === resolve(input)) throw new CliError('refusing to overwrite the input file; choose another --output');
  if (!dryRun && values.force !== true && existsSync(output)) {
    throw new CliError(`${output} already exists (use --force to overwrite)`);
  }

  const original = readInput(input);
  const before = diagnose(original);
  if (!before.header.valid || !before.structure.ok) {
    const reason = before.findings.find((f) => f.severity === 'error');
    throw new CliError(`cannot repair ${input}: ${reason ? describeFinding(reason) : 'file is malformed'}`);
  }

  let bytes = original;
  const steps: Step[] = [];
  const run = <R extends { compressedTimestampsChanged: number }>(
    name: string,
    fn: (b: Uint8Array) => RepairResult<R>,
    describe: (r: R) => string[],
  ) => {
    let result: RepairResult<R>;
    try {
      result = fn(bytes);
    } catch (error) {
      if (error instanceof FitStructureError) throw new CliError(`cannot repair ${input}: ${error.message}`);
      throw error;
    }
    bytes = result.bytes;
    steps.push({
      name,
      changed: result.changed,
      report: result.report,
      lines: describe(result.report),
      compressedTimestampsChanged: result.report.compressedTimestampsChanged,
    });
  };

  if (values.timestamps !== false) run('timestamps', repairTimestamps, formatTimestampRepair);
  if (all || values['strip-gps-metadata'] === true) {
    run('strip-gps-metadata', (b) => stripMessages(b, [MESG_GPS_METADATA]), (r) => formatStrip('strip gps_metadata', r));
  }
  if (all || values['strip-unknown'] === true) {
    run('strip-unknown', (b) => stripMessages(b, before.unknownMesgNums), (r) => formatStrip('strip undefined messages', r));
  }
  if (custom.length > 0) {
    run('strip', (b) => stripMessages(b, custom), (r) => formatStrip(`strip ${custom.join(',')}`, r));
  }
  if (all || values['strip-developer'] === true) {
    run('strip-developer', stripDeveloperFields, (r) => formatStrip('strip developer fields', r));
  }

  const changed = steps.some((s) => s.changed);
  const written = changed && !dryRun;
  if (written) {
    try {
      writeFileSync(output, bytes, { flag: values.force === true ? 'w' : 'wx' });
    } catch (error) {
      throw new CliError(`cannot write ${output}: ${(error as Error).message}`);
    }
  }
  const after = changed ? diagnose(bytes) : null;
  const shifted = steps.reduce((n, s) => n + s.compressedTimestampsChanged, 0);

  if (values.json === true) {
    io.stdout(
      JSON.stringify(
        {
          input,
          output: written ? output : null,
          written,
          dryRun,
          changed,
          steps: steps.map(({ name, changed: c, report }) => ({ name, changed: c, report })),
          before,
          after,
        },
        null,
        2,
      ),
    );
    return EXIT_OK;
  }

  const out: string[] = [];
  if (steps.length === 0) out.push('No repair steps selected.');
  for (const s of steps) out.push(...s.lines.map((l, i) => (i === 0 ? l : `  ${l}`)));
  if (shifted > 0) {
    out.push(
      `! warning: ${shifted} compressed-timestamp records now decode to a different time, ` +
        'because a message they were timed against was changed or removed.',
    );
  }
  if (!changed) {
    out.push('', 'Nothing to change; no file written.');
  } else {
    const size = `${formatBytes(original.length)} → ${formatBytes(bytes.length)}`;
    out.push('', dryRun ? `Dry run: would write ${output} (${size})` : `Wrote ${output} (${size})`);
    const remaining = after!.findings.filter((f) => f.severity !== 'info');
    out.push(remaining.length === 0 ? 'Re-check: no errors or warnings.' : 'Re-check:');
    for (const f of remaining) out.push(`  ${f.severity}: ${describeFinding(f)}`);
  }
  io.stdout(out.join('\n'));
  return EXIT_OK;
}

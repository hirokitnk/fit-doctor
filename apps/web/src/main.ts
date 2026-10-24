import { type Diagnosis, diagnose } from '@fit-doctor/core';
import { preset } from '@fit-doctor/fixtures';
import { type Lang, MESSAGES, type Messages, initialLang, saveLang } from './i18n.js';
import { type PipelineResult, type RepairOptions, repairedFileName, runPipeline } from './pipeline.js';
import './style.css';

interface Loaded {
  name: string;
  bytes: Uint8Array;
  diagnosis: Diagnosis;
}

interface State {
  lang: Lang;
  loaded: Loaded | null;
  options: RepairOptions;
  error: string | null;
  dragging: boolean;
}

const state: State = {
  lang: initialLang(),
  loaded: null,
  options: { timestamps: false, gpsMetadata: false, unknownMessages: false, developerFields: false },
  error: null,
  dragging: false,
};

const root = document.getElementById('app') as HTMLElement;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: (Node | string | null | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v as string;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, String(v));
  }
  for (const c of children) if (c) el.append(c);
  return el;
}

const fmtBytes = (b: number) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KiB` : `${(b / 1048576).toFixed(1)} MiB`);
const fmtInt = (v: number) => v.toLocaleString('en-US');
function fmtDuration(s: number | null): string {
  if (s === null) return '—';
  const sign = s < 0 ? '-' : '';
  const a = Math.abs(Math.round(s));
  const p = (v: number) => String(v).padStart(2, '0');
  return `${sign}${Math.floor(a / 3600)}:${p(Math.floor((a % 3600) / 60))}:${p(a % 60)}`;
}

function count(d: Diagnosis, num: number): number {
  return d.messages.find((m) => m.globalMesgNum === num)?.dataCount ?? 0;
}
function unknownCount(d: Diagnosis): number {
  return d.messages.filter((m) => !m.known).reduce((n, m) => n + m.dataCount, 0);
}

function load(name: string, bytes: Uint8Array): void {
  const diagnosis = diagnose(bytes);
  const t = diagnosis.timestamps;
  state.loaded = { name, bytes, diagnosis };
  state.error = null;
  state.options = {
    timestamps: t.collapsedSuspected,
    gpsMetadata: false,
    unknownMessages: false,
    developerFields: false,
  };
  render();
}

async function loadFile(file: File): Promise<void> {
  try {
    load(file.name, new Uint8Array(await file.arrayBuffer()));
  } catch {
    state.error = MESSAGES[state.lang].loadFailed;
    render();
  }
}

function repairable(d: Diagnosis): boolean {
  return d.header.valid && d.structure.ok;
}

function currentResult(): PipelineResult | null {
  const l = state.loaded;
  if (!l || !repairable(l.diagnosis)) return null;
  return runPipeline(l.bytes, state.options, l.diagnosis);
}

function dropZone(m: Messages): HTMLElement {
  const input = h('input', { type: 'file', accept: '.fit,.FIT', id: 'file' }) as HTMLInputElement;
  input.addEventListener('change', () => {
    const f = input.files?.[0];
    if (f) void loadFile(f);
  });
  const zone = h(
    'div',
    { class: `card drop${state.dragging ? ' over' : ''}` },
    h('p', { class: 'title' }, m.dropTitle),
    h('p', {}, m.dropHint),
    h('p', {}, h('label', { class: 'btn', for: 'file' }, m.browse), input),
    h('p', {}, h('button', { class: 'secondary', type: 'button', onClick: () => { const s = preset('triathlonCollapsed'); load('sample.fit', s.bytes); } }, m.sample)),
    state.error ? h('p', { class: 'err' }, state.error) : null,
  );
  zone.addEventListener('dragover', (e) => { e.preventDefault(); if (!state.dragging) { state.dragging = true; zone.classList.add('over'); } });
  zone.addEventListener('dragleave', () => { state.dragging = false; zone.classList.remove('over'); });
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    state.dragging = false;
    const f = e.dataTransfer?.files[0];
    if (f) void loadFile(f);
  });
  return zone;
}

function option(key: keyof RepairOptions, label: string, help: string, available: boolean): HTMLElement {
  const box = h('input', { type: 'checkbox', id: `opt-${key}`, checked: state.options[key], disabled: !available }) as HTMLInputElement;
  box.addEventListener('change', () => { state.options[key] = box.checked; render(); });
  return h('div', { class: 'opt' }, box, h('label', { for: `opt-${key}` }, label, h('span', { class: 'help' }, help)));
}

function optionsCard(m: Messages, d: Diagnosis): HTMLElement {
  const t = d.timestamps;
  const gps = count(d, 160);
  const unk = unknownCount(d);
  return h(
    'div',
    { class: 'card' },
    h('h2', {}, m.optionsTitle),
    option('timestamps', m.optTimestamps, m.optTimestampsHelp(t.endBeforeStart, t.zeroDuration), t.collapsedSuspected),
    option('gpsMetadata', m.optGps, m.optGpsHelp(gps), gps > 0),
    option('unknownMessages', m.optUnknown, m.optUnknownHelp(d.unknownMesgNums, unk), unk > 0),
    option('developerFields', m.optDeveloper, m.optDeveloperHelp(d.developerFields.dataMessagesWithDeveloperFields), d.developerFields.present),
    h('p', { class: 'note' }, m.modeBNote),
  );
}

function crcText(m: Messages, d: Diagnosis, which: 'header' | 'file'): string {
  return m.crc[(which === 'header' ? d.crc.header : d.crc.file) ?? 'unavailable'] ?? '—';
}

function compareCard(m: Messages, r: PipelineResult): HTMLElement {
  const rows: [string, string, string][] = [];
  const a = r.before;
  const b = r.after;
  rows.push([m.rowSize, fmtBytes(a.fileSize), fmtBytes(b.fileSize)]);
  rows.push([m.rowHeaderCrc, crcText(m, a, 'header'), crcText(m, b, 'header')]);
  rows.push([m.rowFileCrc, crcText(m, a, 'file'), crcText(m, b, 'file')]);
  rows.push([m.rowStructure, a.structure.ok ? m.ok : m.broken, b.structure.ok ? m.ok : m.broken]);
  rows.push([m.rowEndBeforeStart, fmtInt(a.timestamps.endBeforeStart), fmtInt(b.timestamps.endBeforeStart)]);
  rows.push([m.rowZeroDuration, fmtInt(a.timestamps.zeroDuration), fmtInt(b.timestamps.zeroDuration)]);
  rows.push([m.rowActivity, fmtInt(a.timestamps.activity.endBeforeSessionsEnd), fmtInt(b.timestamps.activity.endBeforeSessionsEnd)]);
  rows.push([m.rowDurationSummary, fmtDuration(a.duration.fromSummaryTimestampsSeconds), fmtDuration(b.duration.fromSummaryTimestampsSeconds)]);
  rows.push([m.rowDurationElapsed, fmtDuration(a.duration.fromElapsedTimeSeconds), fmtDuration(b.duration.fromElapsedTimeSeconds)]);
  rows.push([m.rowGps, fmtInt(count(a, 160)), fmtInt(count(b, 160))]);
  rows.push([m.rowUnknown, fmtInt(unknownCount(a)), fmtInt(unknownCount(b))]);
  rows.push([m.rowDeveloper, fmtInt(a.developerFields.dataMessagesWithDeveloperFields), fmtInt(b.developerFields.dataMessagesWithDeveloperFields)]);
  return h(
    'div',
    { class: 'card' },
    h('h2', {}, m.compareTitle),
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        { id: 'compare' },
        h('thead', {}, h('tr', {}, h('th', {}, m.colItem), h('th', { class: 'num' }, m.colBefore), h('th', { class: 'num' }, m.colAfter))),
        h('tbody', {}, ...rows.map(([label, x, y]) => h('tr', {}, h('td', {}, label), h('td', { class: 'num' }, x), h('td', { class: x === y ? 'num' : 'num changed' }, y)))),
      ),
    ),
  );
}

function findingsCard(m: Messages, d: Diagnosis): HTMLElement {
  return h(
    'div',
    { class: 'card' },
    h('h2', {}, m.findingsTitle),
    d.findings.length === 0
      ? h('p', {}, m.noFindings)
      : h('ul', { class: 'findings' }, ...d.findings.map((f) => h('li', {}, h('span', { class: `sev ${f.severity}` }, m.severity[f.severity]), h('span', {}, m.finding(f))))),
  );
}

function download(name: string, bytes: Uint8Array): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/octet-stream' }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function resultSection(m: Messages, l: Loaded): HTMLElement {
  const out = h('div', {});
  out.append(h('p', { id: 'file-info' }, m.fileInfo(l.name, fmtBytes(l.bytes.length))));
  out.append(findingsCard(m, l.diagnosis));
  if (!repairable(l.diagnosis)) {
    out.append(h('p', { class: 'err' }, m.cannotRepair));
    return out;
  }
  out.append(optionsCard(m, l.diagnosis));
  const r = currentResult() as PipelineResult;
  out.append(compareCard(m, r));
  const name = repairedFileName(l.name);
  const anySelected = Object.values(state.options).some(Boolean);
  const btn = h('button', { class: 'btn', id: 'download', type: 'button', disabled: !r.changed, onClick: () => download(name, r.bytes) }, m.download);
  out.append(
    h(
      'div',
      { class: 'card' },
      btn,
      ' ',
      h('span', { class: 'note' }, r.changed ? `${m.downloadHint}: ${name}` : anySelected ? m.unchanged : m.nothingToDo),
      r.compressedTimestampsChanged > 0 ? h('p', { class: 'warn' }, m.compressedWarning(r.compressedTimestampsChanged)) : null,
    ),
  );
  return out;
}

function render(): void {
  const m = MESSAGES[state.lang];
  document.documentElement.lang = state.lang;
  document.title = `fit-doctor — ${m.tagline}`;
  const langButton = (lang: Lang, label: string) =>
    h('button', { type: 'button', 'aria-pressed': state.lang === lang, onClick: () => { state.lang = lang; saveLang(lang); render(); } }, label);
  root.replaceChildren(
    h(
      'main',
      {},
      h('header', {}, h('div', {}, h('h1', {}, m.title), h('p', { class: 'tagline' }, m.tagline)), h('div', { class: 'lang', role: 'group', 'aria-label': m.language }, langButton('ja', '日本語'), langButton('en', 'English'))),
      h('p', { class: 'privacy', id: 'privacy' }, m.privacy),
      dropZone(m),
      state.loaded ? resultSection(m, state.loaded) : null,
      h('footer', {}, m.footer),
    ),
  );
}

render();

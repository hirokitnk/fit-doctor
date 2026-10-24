import type { Finding } from '@fit-doctor/core';

export type Lang = 'ja' | 'en';

export interface Messages {
  title: string;
  tagline: string;
  privacy: string;
  dropTitle: string;
  dropHint: string;
  browse: string;
  sample: string;
  loadFailed: string;
  fileInfo: (name: string, size: string) => string;
  optionsTitle: string;
  optTimestamps: string;
  optTimestampsHelp: (before: number, zero: number) => string;
  optGps: string;
  optGpsHelp: (n: number) => string;
  optUnknown: string;
  optUnknownHelp: (nums: number[], n: number) => string;
  optDeveloper: string;
  optDeveloperHelp: (n: number) => string;
  nothingToDo: string;
  modeBNote: string;
  compareTitle: string;
  colItem: string;
  colBefore: string;
  colAfter: string;
  rowSize: string;
  rowHeaderCrc: string;
  rowFileCrc: string;
  rowStructure: string;
  rowEndBeforeStart: string;
  rowZeroDuration: string;
  rowActivity: string;
  rowDurationSummary: string;
  rowDurationElapsed: string;
  rowGps: string;
  rowUnknown: string;
  rowDeveloper: string;
  ok: string;
  broken: string;
  crc: Record<string, string>;
  findingsTitle: string;
  noFindings: string;
  severity: Record<'error' | 'warning' | 'info', string>;
  download: string;
  downloadHint: string;
  cannotRepair: string;
  compressedWarning: (n: number) => string;
  unchanged: string;
  language: string;
  footer: string;
  finding: (f: Finding) => string;
}

const n = (v: unknown) => Number(v).toLocaleString('en-US');

export const MESSAGES: Record<Lang, Messages> = {
  en: {
    title: 'fit-doctor',
    tagline: 'Diagnose and repair .fit files that Garmin Connect refuses to import.',
    privacy: 'Everything runs in your browser. Your file is never uploaded or sent anywhere, and this page has no analytics or tracking. FIT files contain GPS tracks, so this matters.',
    dropTitle: 'Drop a .fit file here',
    dropHint: 'or',
    browse: 'Choose a file',
    sample: 'Try a synthetic sample',
    loadFailed: 'Could not read the file.',
    fileInfo: (name, size) => `${name} (${size})`,
    optionsTitle: 'Repairs to apply',
    optTimestamps: 'Fix collapsed end times (lap / session / activity / time_in_zone)',
    optTimestampsHelp: (b, z) => `${n(b)} end-before-start, ${n(z)} zero-duration found`,
    optGps: 'Remove gps_metadata (160)',
    optGpsHelp: (c) => `${n(c)} messages`,
    optUnknown: 'Remove messages undefined in the public profile',
    optUnknownHelp: (nums, c) => (nums.length ? `numbers ${nums.join(', ')}: ${n(c)} messages` : 'none present'),
    optDeveloper: 'Remove Connect IQ developer fields',
    optDeveloperHelp: (c) => `${n(c)} data messages`,
    nothingToDo: 'Nothing selected.',
    modeBNote: 'Which of the three removals (if any) makes Garmin Connect accept a file is not known. Try them one at a time.',
    compareTitle: 'Before and after',
    colItem: 'Item',
    colBefore: 'Before',
    colAfter: 'After',
    rowSize: 'File size',
    rowHeaderCrc: 'Header CRC',
    rowFileCrc: 'File CRC',
    rowStructure: 'Structure',
    rowEndBeforeStart: 'End time earlier than start',
    rowZeroDuration: 'End time equal to start (elapsed > 0)',
    rowActivity: 'Activity ends before last session',
    rowDurationSummary: 'Duration from summary timestamps (what Connect computes)',
    rowDurationElapsed: 'Duration from start_time + elapsed',
    rowGps: 'gps_metadata messages',
    rowUnknown: 'Undefined-profile messages',
    rowDeveloper: 'Data messages with developer fields',
    ok: 'OK',
    broken: 'Broken',
    crc: { valid: 'valid', zero: 'not set (0x0000)', invalid: 'invalid', absent: 'none (12-byte header)', unavailable: 'unavailable' },
    findingsTitle: 'Findings',
    noFindings: 'No problems found.',
    severity: { error: 'Error', warning: 'Warning', info: 'Info' },
    download: 'Download repaired file',
    downloadHint: 'Saved as',
    cannotRepair: 'This file is structurally broken, so it cannot be repaired safely.',
    compressedWarning: (c) => `${n(c)} compressed-timestamp records will decode to a different time because a message they were timed against changes.`,
    unchanged: 'The selected repairs change nothing in this file.',
    language: 'Language',
    footer: 'MIT licensed. Repairs overwrite or delete bytes in place; nothing is decoded and re-encoded.',
    finding: (f) => {
      const p = f.params;
      switch (f.code) {
        case 'header-invalid': return `Not a usable FIT header (${p.reason}).`;
        case 'structure-error': return `Record structure is broken at offset ${p.offset} (${p.reason}).`;
        case 'header-crc-invalid': return 'Header CRC does not match.';
        case 'file-crc-invalid': return 'File CRC does not match.';
        case 'trailing-bytes': return `${n(p.count)} bytes follow the file CRC; they are not checked.`;
        case 'summary-end-before-start': return `${n(p.count)} summary end times are earlier than their start (laps ${p.laps}, sessions ${p.sessions}, time_in_zone ${p.timeInZones}). Garmin Connect rejects negative durations.`;
        case 'summary-zero-duration': return `${n(p.count)} summary end times equal their start despite a non-zero elapsed time (laps ${p.laps}, sessions ${p.sessions}, time_in_zone ${p.timeInZones}).`;
        case 'summary-end-mismatch': return `${n(p.count)} summary end times differ from start_time + total_elapsed_time by more than 1 s.`;
        case 'activity-before-sessions-end': return 'The activity end time is earlier than the end of its last session.';
        case 'gps-metadata-present': return `${n(p.count)} gps_metadata (160) messages. Removing them has helped some files import (unconfirmed).`;
        case 'unknown-messages-present': return `${n(p.count)} messages with numbers undefined in the public profile: ${(p.mesgNums as number[]).join(', ')}.`;
        case 'developer-fields-present': return `Connect IQ developer fields on ${n(p.count)} data messages.`;
      }
    },
  },
  ja: {
    title: 'fit-doctor',
    tagline: 'Garmin Connect に取り込めない .fit ファイルを診断・修復します。',
    privacy: '処理はすべてブラウザ内で完結します。ファイルが外部に送信・アップロードされることはなく、アナリティクスやトラッキングもありません。FIT ファイルには GPS の軌跡が含まれるためです。',
    dropTitle: '.fit ファイルをここにドロップ',
    dropHint: 'または',
    browse: 'ファイルを選択',
    sample: '合成サンプルで試す',
    loadFailed: 'ファイルを読み込めませんでした。',
    fileInfo: (name, size) => `${name}（${size}）`,
    optionsTitle: '適用する修復',
    optTimestamps: '潰れた終了時刻を修復（lap / session / activity / time_in_zone）',
    optTimestampsHelp: (b, z) => `終了 < 開始: ${n(b)} 件、所要時間0秒: ${n(z)} 件`,
    optGps: 'gps_metadata (160) を削除',
    optGpsHelp: (c) => `${n(c)} 件`,
    optUnknown: '公開プロファイルに定義のないメッセージを削除',
    optUnknownHelp: (nums, c) => (nums.length ? `番号 ${nums.join(', ')}: ${n(c)} 件` : '該当なし'),
    optDeveloper: 'Connect IQ 開発者フィールドを削除',
    optDeveloperHelp: (c) => `${n(c)} 件のデータメッセージ`,
    nothingToDo: '何も選択されていません。',
    modeBNote: '3つの削除のうちどれが（あるいはどれも）Garmin Connect での取り込みに効くかは分かっていません。1つずつ試してください。',
    compareTitle: '修復前後の比較',
    colItem: '項目',
    colBefore: '修復前',
    colAfter: '修復後',
    rowSize: 'ファイルサイズ',
    rowHeaderCrc: 'ヘッダ CRC',
    rowFileCrc: 'ファイル CRC',
    rowStructure: '構造',
    rowEndBeforeStart: '終了時刻が開始より前',
    rowZeroDuration: '終了時刻 = 開始時刻（所要時間 > 0）',
    rowActivity: 'activity が最後の session より前に終了',
    rowDurationSummary: 'サマリー時刻からの所要時間（Connect が計算する値）',
    rowDurationElapsed: 'start_time + 経過時間からの所要時間',
    rowGps: 'gps_metadata メッセージ',
    rowUnknown: 'プロファイル未定義のメッセージ',
    rowDeveloper: '開発者フィールドを持つデータメッセージ',
    ok: '正常',
    broken: '破損',
    crc: { valid: '有効', zero: '未設定 (0x0000)', invalid: '不正', absent: 'なし（12バイトヘッダ）', unavailable: '取得不可' },
    findingsTitle: '診断結果',
    noFindings: '問題は見つかりませんでした。',
    severity: { error: 'エラー', warning: '警告', info: '情報' },
    download: '修復後のファイルをダウンロード',
    downloadHint: '保存名',
    cannotRepair: 'このファイルは構造が壊れているため、安全に修復できません。',
    compressedWarning: (c) => `${n(c)} 件の圧縮タイムスタンプのレコードは、基準にしていたメッセージが変わるため、別の時刻にデコードされます。`,
    unchanged: '選択した修復では、このファイルに変更はありません。',
    language: '言語',
    footer: 'MIT ライセンス。修復は既存バイト列の上書き・削除のみで、デコードや再エンコードは行いません。',
    finding: (f) => {
      const p = f.params;
      switch (f.code) {
        case 'header-invalid': return `FIT ヘッダとして使えません（${p.reason}）。`;
        case 'structure-error': return `オフセット ${p.offset} でレコード構造が壊れています（${p.reason}）。`;
        case 'header-crc-invalid': return 'ヘッダ CRC が一致しません。';
        case 'file-crc-invalid': return 'ファイル CRC が一致しません。';
        case 'trailing-bytes': return `ファイル CRC の後ろに ${n(p.count)} バイトあります（検証対象外）。`;
        case 'summary-end-before-start': return `${n(p.count)} 件のサマリー終了時刻が開始時刻より前です（lap ${p.laps}、session ${p.sessions}、time_in_zone ${p.timeInZones}）。Garmin Connect は負の所要時間を受け付けません。`;
        case 'summary-zero-duration': return `${n(p.count)} 件のサマリー終了時刻が、経過時間があるのに開始時刻と同じです（lap ${p.laps}、session ${p.sessions}、time_in_zone ${p.timeInZones}）。`;
        case 'summary-end-mismatch': return `${n(p.count)} 件のサマリー終了時刻が start_time + total_elapsed_time と1秒より大きくずれています。`;
        case 'activity-before-sessions-end': return 'activity の終了時刻が、最後の session の終了より前です。';
        case 'gps-metadata-present': return `gps_metadata (160) が ${n(p.count)} 件あります。削除で取り込めた例があります（未確認）。`;
        case 'unknown-messages-present': return `公開プロファイルに定義のない番号のメッセージが ${n(p.count)} 件あります: ${(p.mesgNums as number[]).join(', ')}。`;
        case 'developer-fields-present': return `${n(p.count)} 件のデータメッセージに Connect IQ 開発者フィールドがあります。`;
      }
    },
  },
};

export function initialLang(): Lang {
  try {
    const saved = localStorage.getItem('fit-doctor-lang');
    if (saved === 'ja' || saved === 'en') return saved;
  } catch {
    // storage unavailable: fall through
  }
  return navigator.language.toLowerCase().startsWith('ja') ? 'ja' : 'en';
}

export function saveLang(lang: Lang): void {
  try {
    localStorage.setItem('fit-doctor-lang', lang);
  } catch {
    // ignore
  }
}

import type { Finding, FindingCode } from '@fit-doctor/core';
import { describe, expect, it } from 'vitest';
import { MESSAGES } from '../src/i18n.js';

const CODES: FindingCode[] = [
  'header-invalid', 'structure-error', 'header-crc-invalid', 'file-crc-invalid', 'trailing-bytes',
  'summary-end-before-start', 'summary-zero-duration', 'summary-end-mismatch', 'activity-before-sessions-end',
  'gps-metadata-present', 'unknown-messages-present', 'developer-fields-present',
];

describe('i18n', () => {
  it('has the same keys in both languages', () => {
    expect(Object.keys(MESSAGES.ja).sort()).toEqual(Object.keys(MESSAGES.en).sort());
  });

  it.each(['en', 'ja'] as const)('%s describes every finding code', (lang) => {
    for (const code of CODES) {
      const f: Finding = { code, severity: 'info', params: { count: 3, laps: 1, sessions: 1, timeInZones: 1, reason: 'x', offset: 5, mesgNums: [233] } };
      const text = MESSAGES[lang].finding(f);
      expect(text.length).toBeGreaterThan(5);
      expect(text).not.toMatch(/NaN|\[object|undefined(?! in)/);
    }
  });

  it('states the privacy guarantee in both languages', () => {
    expect(MESSAGES.en.privacy).toMatch(/never uploaded/);
    expect(MESSAGES.ja.privacy).toMatch(/送信/);
  });
});

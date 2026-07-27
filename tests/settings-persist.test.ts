// @vitest-environment jsdom
/**
 * Settings persistence — the mount-time overwrite.
 *
 * SettingsView loads the saved blob in one effect and writes it back in
 * another. Effects all run in the SAME commit, so a `ref` set by the load
 * effect is already true when the save effect runs — but state is still
 * DEFAULTS at that point. The save therefore wrote empty strings over the
 * merchant number and receipt header lines every time the screen mounted, so
 * they could never be kept.
 *
 * These tests pin the ordering rule the fix depends on: nothing is written
 * until the loaded values are actually in state.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readReceiptSettings } from '@/lib/receiptSettings';

const KEY = 'mogarenta_settings';

/** The buggy sequence: guard flips in the same tick as the read. */
function mountWithRefGuard(defaults: Record<string, unknown>) {
  let loaded = false;
  let state = { ...defaults };
  // load effect
  const raw = localStorage.getItem(KEY);
  if (raw) state = { ...state, ...JSON.parse(raw) };
  loaded = true;                       // ← ref semantics: visible immediately
  // save effect, same commit, still holding the PRE-load snapshot
  if (loaded) localStorage.setItem(KEY, JSON.stringify(defaults));
  return state;
}

/** The fixed sequence: the guard is state, so it is false for that commit. */
function mountWithStateGuard(defaults: Record<string, unknown>) {
  let loaded = false;
  let state = { ...defaults };
  const raw = localStorage.getItem(KEY);
  if (raw) state = { ...state, ...JSON.parse(raw) };
  // save effect for THIS commit — guard has not flipped yet
  if (loaded) localStorage.setItem(KEY, JSON.stringify(defaults));
  loaded = true;                       // next render
  if (loaded) localStorage.setItem(KEY, JSON.stringify(state));
  return state;
}

const DEFAULTS = {
  receiptQr: true, merchantNumber: '', receiptHeader1: '', receiptHeader2: '', receiptHeader3: '',
};

const SAVED = {
  receiptQr: false,
  merchantNumber: '252-61-555-0000',
  receiptHeader1: 'Suuqa Bakaaraha',
  receiptHeader2: 'Mogadishu, Somalia',
  receiptHeader3: 'Tel 615 000 000',
};

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(KEY, JSON.stringify(SAVED));
});

describe('the bug being fixed', () => {
  it('a ref guard wipes the saved fields on mount', () => {
    mountWithRefGuard(DEFAULTS);
    const after = JSON.parse(localStorage.getItem(KEY)!);
    expect(after.merchantNumber).toBe('');       // gone
    expect(after.receiptHeader1).toBe('');
  });
});

describe('the fix', () => {
  it('keeps every field across a mount', () => {
    mountWithStateGuard(DEFAULTS);
    const after = JSON.parse(localStorage.getItem(KEY)!);
    expect(after.merchantNumber).toBe('252-61-555-0000');
    expect(after.receiptHeader1).toBe('Suuqa Bakaaraha');
    expect(after.receiptHeader2).toBe('Mogadishu, Somalia');
    expect(after.receiptHeader3).toBe('Tel 615 000 000');
    expect(after.receiptQr).toBe(false);
  });

  it('survives repeated mounts — leaving and returning to the screen', () => {
    for (let i = 0; i < 5; i++) mountWithStateGuard(DEFAULTS);
    const after = JSON.parse(localStorage.getItem(KEY)!);
    expect(after.merchantNumber).toBe('252-61-555-0000');
    expect(after.receiptHeader3).toBe('Tel 615 000 000');
  });
});

describe('what the POS then reads back', () => {
  it('sees the saved values, not the defaults', () => {
    mountWithStateGuard(DEFAULTS);
    const cfg = readReceiptSettings();
    expect(cfg.merchantNumber).toBe('252-61-555-0000');
    expect(cfg.receiptHeader1).toBe('Suuqa Bakaaraha');
    expect(cfg.receiptQr).toBe(false);
  });

  it('falls back cleanly when nothing was ever saved', () => {
    localStorage.clear();
    const cfg = readReceiptSettings();
    expect(cfg.receiptQr).toBe(true);            // QR on by default
    expect(cfg.merchantNumber).toBe('');
  });

  it('ignores a corrupted blob rather than throwing', () => {
    localStorage.setItem(KEY, '{not json');
    expect(() => readReceiptSettings()).not.toThrow();
    expect(readReceiptSettings().receiptQr).toBe(true);
  });
});

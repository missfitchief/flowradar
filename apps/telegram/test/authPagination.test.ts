import { describe, expect, it } from 'vitest';
import { isAuthorized, parseAllowedUserIds } from '../src/auth';
import { callback, navKeyboard } from '../src/render';

describe('Telegram authorization and callback pagination', () => {
  it('fails closed on missing/malformed allowlist and accepts exact ids only', () => {
    expect(() => parseAllowedUserIds(undefined)).toThrow(/required|must contain/i);
    expect(() => parseAllowedUserIds('123,abc')).toThrow(/invalid/i);
    const allowed = parseAllowedUserIds('123, 456');
    expect(isAuthorized(allowed, 123)).toBe(true);
    expect(isAuthorized(allowed, 12)).toBe(false);
  });

  it('keeps versioned callback data within Telegram 64-byte limit', () => {
    const value = callback('page', 'cm123456789012345678901234', '999');
    expect(Buffer.byteLength(value)).toBeLessThanOrEqual(64);
    const keyboard = navKeyboard('cm123', 2, true);
    expect(keyboard.inline_keyboard[0]).toHaveLength(2);
    expect(keyboard.inline_keyboard.at(-1)?.map((x) => x.text)).toEqual(['📦 Export']);
  });
});

import { describe, expect, test } from 'bun:test';
import { isReloginRequired } from '../src/features/authFiles/constants';
import type { AuthFileItem } from '../src/types';

const file = (overrides: Partial<AuthFileItem> = {}): AuthFileItem => ({
  name: 'credential.json',
  type: 'codex',
  ...overrides,
});

describe('isReloginRequired', () => {
  test('flags a rejected refresh token', () => {
    expect(
      isReloginRequired(
        file({ status: 'error', unavailable: true, statusMessage: 'unauthorized (refresh token invalid)' })
      )
    ).toBe(true);
  });

  test('flags invalid_grant on snake_case status_message', () => {
    expect(
      isReloginRequired(
        file({ status: 'error', status_message: '{"error":"invalid_grant"}' } as Partial<AuthFileItem>)
      )
    ).toBe(true);
  });

  test('ignores model-support errors that a re-login cannot fix', () => {
    expect(
      isReloginRequired(
        file({
          status: 'error',
          unavailable: true,
          statusMessage: "The 'gpt-6.1-terra' model is not supported when using Codex with a ChatGPT account.",
        })
      )
    ).toBe(false);
  });

  test('ignores healthy and deliberately disabled credentials', () => {
    expect(isReloginRequired(file({ status: 'active' }))).toBe(false);
    expect(
      isReloginRequired(file({ disabled: true, status: 'disabled', statusMessage: 'unauthorized' }))
    ).toBe(false);
  });
});

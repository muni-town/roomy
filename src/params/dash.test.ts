import { describe, it, expect } from 'vitest';
import { match } from './dash';

describe('dash parameter matcher', () => {
  it('matches the dash character', () => {
    expect(match('-')).toBe(true);
  });

  it('does not match other characters', () => {
    expect(match('a')).toBe(false);
    expect(match('/')).toBe(false);
    expect(match('--')).toBe(false);
    expect(match('')).toBe(false);
  });
});

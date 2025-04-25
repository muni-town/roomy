import { describe, it, expect } from 'vitest';
import { match } from './space';

describe('space parameter matcher', () => {
  it('matches strings starting with "leaf:"', () => {
    expect(match('leaf:abc123')).toBe(true);
    expect(match('leaf:')).toBe(true);
  });

  it('matches strings containing a dot', () => {
    expect(match('example.com')).toBe(true);
    expect(match('a.b')).toBe(true);
    expect(match('domain.with.multiple.dots')).toBe(true);
  });

  it('does not match other strings', () => {
    expect(match('abc123')).toBe(false);
    expect(match('leafabc')).toBe(false);
    expect(match('')).toBe(false);
  });
});

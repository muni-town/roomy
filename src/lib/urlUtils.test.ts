import { describe, it, expect } from 'vitest';
import { convertUrlsToLinks } from './urlUtils';

describe('urlUtils', () => {
  describe('convertUrlsToLinks', () => {
    it('converts plain URLs to HTML links', () => {
      const input = 'Check out https://example.com for more info';
      const expected = 'Check out <a target="_blank" href="https://example.com">https://example.com</a> for more info';
      expect(convertUrlsToLinks(input)).toBe(expected);
    });

    it('handles multiple URLs in the same string', () => {
      const input = 'Visit https://example.com and http://test.org';
      const expected = 'Visit <a target="_blank" href="https://example.com">https://example.com</a> and <a target="_blank" href="http://test.org">http://test.org</a>';
      expect(convertUrlsToLinks(input)).toBe(expected);
    });

    it('converts newlines to <br> tags', () => {
      const input = 'Line 1\nLine 2\nhttp://example.com';
      const expected = 'Line 1<br>Line 2<br><a target="_blank" href="http://example.com">http://example.com</a>';
      expect(convertUrlsToLinks(input)).toBe(expected);
    });

    it('handles URLs with paths and query parameters', () => {
      const input = 'Check https://example.com/path?query=value#fragment';
      const expected = 'Check <a target="_blank" href="https://example.com/path?query=value#fragment">https://example.com/path?query=value#fragment</a>';
      expect(convertUrlsToLinks(input)).toBe(expected);
    });

    it('returns the original string if no URLs are found', () => {
      const input = 'This is a string with no URLs';
      expect(convertUrlsToLinks(input)).toBe(input);
    });

    it('handles empty string input', () => {
      expect(convertUrlsToLinks('')).toBe('');
    });

    it('recognizes URLs without http/https protocol', () => {
      const input = 'Visit example.com';
      const expected = 'Visit <a target="_blank" href="http://example.com">example.com</a>';
      expect(convertUrlsToLinks(input)).toBe(expected);
    });

    it('handles URLs with special characters', () => {
      const input = 'Check out https://example.com/path-with_special~chars';
      const expected = 'Check out <a target="_blank" href="https://example.com/path-with_special~chars">https://example.com/path-with_special~chars</a>';
      expect(convertUrlsToLinks(input)).toBe(expected);
    });
  });
});

import { describe, it, expect } from 'vitest';
import { encodeBase32, decodeBase32 } from './base32';

describe('base32', () => {
  describe('encodeBase32', () => {
    it('encodes Uint8Array to base32 string', () => {
      const input = new Uint8Array([104, 101, 108, 108, 111]); // "hello" in ASCII
      const result = encodeBase32(input);
      expect(result).toBe('d1jprv3f'); // Expected base32 encoding of "hello"
    });

    it('returns lowercase string', () => {
      const input = new Uint8Array([65, 66, 67]); // "ABC" in ASCII
      const result = encodeBase32(input);
      expect(result).toBe(result.toLowerCase());
    });

    it('handles empty array', () => {
      const input = new Uint8Array([]);
      const result = encodeBase32(input);
      expect(result).toBe('');
    });
  });

  describe('decodeBase32', () => {
    it('decodes base32 string to Uint8Array', () => {
      const input = 'd1jprv3f'; // "hello" in base32
      const result = decodeBase32(input);
      
      // Check if result is a Uint8Array
      expect(result).toBeInstanceOf(Uint8Array);
      
      // Check if the decoded bytes match "hello" in ASCII
      expect(Array.from(result)).toEqual([104, 101, 108, 108, 111]);
    });

    it('handles empty string', () => {
      const input = '';
      const result = decodeBase32(input);
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result.length).toBe(0);
    });

    it('is case-insensitive', () => {
      const lowercase = 'd1jprv3f';
      const uppercase = 'D1JPRV3F';
      
      const result1 = decodeBase32(lowercase);
      const result2 = decodeBase32(uppercase);
      
      expect(Array.from(result1)).toEqual(Array.from(result2));
    });

    it('round-trips correctly', () => {
      const original = new Uint8Array([1, 2, 3, 4, 5, 255, 254, 253]);
      const encoded = encodeBase32(original);
      const decoded = decodeBase32(encoded);
      
      expect(Array.from(decoded)).toEqual(Array.from(original));
    });
  });
});

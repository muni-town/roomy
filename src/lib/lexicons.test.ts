import { describe, it, expect } from 'vitest';
import { lexicons } from './lexicons';

describe('lexicons', () => {
  it('exports lexicons array', () => {
    expect(lexicons).toBeDefined();
    expect(Array.isArray(lexicons)).toBe(true);
    expect(lexicons.length).toBeGreaterThan(0);
  });

  it('each lexicon has required properties', () => {
    lexicons.forEach(lexicon => {
      expect(lexicon).toHaveProperty('lexicon');
      expect(lexicon).toHaveProperty('id');
      expect(lexicon).toHaveProperty('defs');
      
      // Check lexicon version is a number
      expect(typeof lexicon.lexicon).toBe('number');
      
      // Check ID is a string and follows expected format
      expect(typeof lexicon.id).toBe('string');
      expect(lexicon.id).toMatch(/^[a-z0-9\.\-_]+$/i);
      
      // Check defs is an object
      expect(typeof lexicon.defs).toBe('object');
    });
  });

  it('lexicon IDs follow expected naming pattern', () => {
    lexicons.forEach(lexicon => {
      // Most lexicons should start with chat.roomy
      const validPrefix = lexicon.id.startsWith('chat.roomy') || 
                          lexicon.id.includes('town.muni');
      expect(validPrefix).toBe(true);
    });
  });

  it('lexicon definitions have valid structure', () => {
    lexicons.forEach(lexicon => {
      // Check that defs has a main property
      expect(lexicon.defs).toHaveProperty('main');
      
      const main = lexicon.defs.main;
      
      // Check that main has a type property
      expect(main).toHaveProperty('type');
      
      // Type should be one of the expected values
      const validTypes = ['query', 'procedure', 'record'];
      expect(validTypes).toContain(main.type);
      
      // If it's a query, it should have output
      if (main.type === 'query') {
        if (main.output) {
          expect(main.output).toHaveProperty('encoding');
        }
      }
      
      // If it's a record, it should have record definition
      if (main.type === 'record') {
        expect(main).toHaveProperty('record');
        expect(typeof main.record).toBe('object');
      }
    });
  });
});

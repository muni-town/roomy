import { describe, it, expect } from 'vitest';
import { themes } from './themes';

describe('themes', () => {
  it('exports themes object with theme definitions', () => {
    expect(themes).toBeDefined();
    expect(typeof themes).toBe('object');
  });

  it('contains expected theme keys', () => {
    // Check for some common themes
    expect(themes).toHaveProperty('[data-theme=dark]');
    expect(themes).toHaveProperty('[data-theme=light]');
  });

  it('each theme has required color properties', () => {
    // Test a sample of themes
    const themeKeys = Object.keys(themes);
    
    themeKeys.forEach(themeKey => {
      const theme = themes[themeKey];
      
      // Check for primary colors
      expect(theme).toHaveProperty('primary');
      expect(theme).toHaveProperty('primary-focus');
      expect(theme).toHaveProperty('primary-content');
      
      // Check for secondary colors
      expect(theme).toHaveProperty('secondary');
      expect(theme).toHaveProperty('secondary-focus');
      expect(theme).toHaveProperty('secondary-content');
      
      // Check for base colors
      expect(theme).toHaveProperty('base-100');
      expect(theme).toHaveProperty('base-content');
    });
  });

  it('color values are valid CSS color strings', () => {
    // Sample a theme to check color values
    const darkTheme = themes['[data-theme=dark]'];
    
    // Check that color values are strings and follow expected format
    expect(typeof darkTheme.primary).toBe('string');
    expect(darkTheme.primary).toMatch(/^#[0-9a-f]{6}$/i);
    
    expect(typeof darkTheme['primary-focus']).toBe('string');
    expect(darkTheme['primary-focus']).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

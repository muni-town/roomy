import { describe, it, expect } from 'vitest';
import { renderMarkdownSanitized } from './markdown';

describe('markdown', () => {
  describe('renderMarkdownSanitized', () => {
    it('converts markdown to HTML', () => {
      const input = '# Heading\n\nThis is a paragraph with **bold** and *italic* text.';
      const result = renderMarkdownSanitized(input);

      expect(result).toContain('<h1>Heading</h1>');
      expect(result).toContain('<p>This is a paragraph with <strong>bold</strong> and <em>italic</em> text.</p>');
    });

    it('sanitizes HTML to prevent XSS', () => {
      const input = 'Normal text <script>alert("XSS")</script> <img src="x" onerror="alert(\'XSS\')">';
      const result = renderMarkdownSanitized(input);

      expect(result).not.toContain('<script>');
      expect(result).not.toContain('onerror=');
    });

    it('adds target="_blank" to links', () => {
      const input = 'Check out [this link](https://example.com)';
      const result = renderMarkdownSanitized(input);

      expect(result).toContain('<a target="_blank" href="https://example.com">this link</a>');
    });

    it('handles code blocks', () => {
      const input = '```javascript\nconst x = 1;\nconsole.log(x);\n```';
      const result = renderMarkdownSanitized(input);

      // The sanitizer might strip the language class, so just check for code block structure
      expect(result).toContain('<pre><code>');
      expect(result).toContain('const x = 1;');
      expect(result).toContain('console.log(x);');
    });

    it('handles lists', () => {
      const input = '- Item 1\n- Item 2\n- Item 3';
      const result = renderMarkdownSanitized(input);

      expect(result).toContain('<ul>');
      expect(result).toContain('<li>Item 1</li>');
      expect(result).toContain('<li>Item 2</li>');
      expect(result).toContain('<li>Item 3</li>');
      expect(result).toContain('</ul>');
    });

    it('handles empty input', () => {
      const result = renderMarkdownSanitized('');
      expect(result).toBe('');
    });
  });
});

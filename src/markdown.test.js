import { describe, expect, it } from 'vitest';

await import('../public/markdown.js');

const markdown = globalThis.fukuMarkdown;

describe('chat markdown parser', () => {
  it('parses bot-style bold text and unordered lists', () => {
    const blocks = markdown.parseMarkdown('ふくのノート\n\n* **収入**: 705,266円\n* **支出**: 639,215円');

    expect(blocks).toEqual([
      { type: 'paragraph', lines: ['ふくのノート'] },
      {
        type: 'list',
        ordered: false,
        items: ['**収入**: 705,266円', '**支出**: 639,215円']
      }
    ]);
    expect(markdown.parseInline(blocks[1].items[0])).toContainEqual({ type: 'strong', value: '収入' });
  });

  it('parses headings, ordered lists, blockquotes, and fenced code', () => {
    const blocks = markdown.parseMarkdown('# 見出し\n\n1. 最初\n2. 次\n\n> 注意\n\n```text\nconst value = 1;\n```');

    expect(blocks).toEqual([
      { type: 'heading', level: 1, text: '見出し' },
      { type: 'list', ordered: true, items: ['最初', '次'] },
      { type: 'blockquote', lines: ['注意'] },
      { type: 'code', language: 'text', value: 'const value = 1;' }
    ]);
  });

  it('leaves raw HTML as text and only accepts https links', () => {
    expect(markdown.parseInline('<img src=x onerror=alert(1)>')).toEqual([
      { type: 'text', value: '<img src=x onerror=alert(1)>' }
    ]);
    expect(markdown.parseInline('[safe](https://example.com)')).toEqual([
      { type: 'link', value: 'safe', url: 'https://example.com' }
    ]);
    expect(markdown.parseInline('[unsafe](javascript:alert(1))')).toEqual([
      { type: 'text', value: '[unsafe](javascript:alert(1))' }
    ]);
  });
});

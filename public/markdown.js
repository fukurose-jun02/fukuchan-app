(function () {
  function parseInline(value) {
    const text = String(value ?? '');
    const tokens = [];
    let buffer = '';

    function flushText() {
      if (buffer) {
        tokens.push({ type: 'text', value: buffer });
        buffer = '';
      }
    }

    function pushDelimited(type, marker, start) {
      const end = text.indexOf(marker, start + marker.length);
      if (end <= start + marker.length) return false;
      flushText();
      tokens.push({ type, value: text.slice(start + marker.length, end) });
      i = end + marker.length;
      return true;
    }

    let i = 0;
    while (i < text.length) {
      if ((text.startsWith('**', i) || text.startsWith('__', i)) &&
          pushDelimited('strong', text.slice(i, i + 2), i)) {
        continue;
      }

      if (text[i] === '`' && pushDelimited('code', '`', i)) {
        continue;
      }

      if (text[i] === '[') {
        const match = text.slice(i).match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/);
        if (match) {
          flushText();
          tokens.push({ type: 'link', value: match[1], url: match[2] });
          i += match[0].length;
          continue;
        }
      }

      buffer += text[i];
      i++;
    }
    flushText();
    return tokens;
  }

  function parseMarkdown(markdown) {
    const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
    const blocks = [];
    let paragraphLines = [];
    let list = null;
    let quoteLines = [];
    let codeLines = null;
    let codeLanguage = '';

    function flushParagraph() {
      if (paragraphLines.length) {
        blocks.push({ type: 'paragraph', lines: paragraphLines });
        paragraphLines = [];
      }
    }

    function flushList() {
      if (list) {
        blocks.push(list);
        list = null;
      }
    }

    function flushQuote() {
      if (quoteLines.length) {
        blocks.push({ type: 'blockquote', lines: quoteLines });
        quoteLines = [];
      }
    }

    function flushTextBlocks() {
      flushParagraph();
      flushList();
      flushQuote();
    }

    for (const line of lines) {
      if (codeLines) {
        if (/^\s*```\s*$/.test(line)) {
          blocks.push({ type: 'code', language: codeLanguage, value: codeLines.join('\n') });
          codeLines = null;
          codeLanguage = '';
        } else {
          codeLines.push(line);
        }
        continue;
      }

      const fence = line.match(/^\s*```\s*([^\s`]*)\s*$/);
      if (fence) {
        flushTextBlocks();
        codeLines = [];
        codeLanguage = fence[1] || '';
        continue;
      }

      if (/^\s*$/.test(line)) {
        flushTextBlocks();
        continue;
      }

      const heading = line.match(/^ {0,3}(#{1,3})\s+(.+?)\s*#*\s*$/);
      if (heading) {
        flushTextBlocks();
        blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] });
        continue;
      }

      const unordered = line.match(/^\s*[-*+]\s+(.*)$/);
      if (unordered) {
        flushParagraph();
        flushQuote();
        if (!list || list.ordered) {
          flushList();
          list = { type: 'list', ordered: false, items: [] };
        }
        list.items.push(unordered[1]);
        continue;
      }

      const ordered = line.match(/^\s*\d+\.\s+(.*)$/);
      if (ordered) {
        flushParagraph();
        flushQuote();
        if (!list || !list.ordered) {
          flushList();
          list = { type: 'list', ordered: true, items: [] };
        }
        list.items.push(ordered[1]);
        continue;
      }

      const quote = line.match(/^\s*>\s?(.*)$/);
      if (quote) {
        flushParagraph();
        flushList();
        quoteLines.push(quote[1]);
        continue;
      }

      flushList();
      flushQuote();
      paragraphLines.push(line);
    }

    if (codeLines) {
      blocks.push({ type: 'code', language: codeLanguage, value: codeLines.join('\n') });
    }
    flushTextBlocks();
    return blocks;
  }

  function appendInline(parent, value) {
    for (const token of parseInline(value)) {
      if (token.type === 'text') {
        const parts = token.value.split('\n');
        parts.forEach((part, index) => {
          if (part) parent.appendChild(document.createTextNode(part));
          if (index < parts.length - 1) parent.appendChild(document.createElement('br'));
        });
        continue;
      }

      if (token.type === 'strong') {
        const strong = document.createElement('strong');
        appendInline(strong, token.value);
        parent.appendChild(strong);
        continue;
      }

      if (token.type === 'code') {
        const code = document.createElement('code');
        code.textContent = token.value;
        parent.appendChild(code);
        continue;
      }

      const link = document.createElement('a');
      link.href = token.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = token.value;
      parent.appendChild(link);
    }
  }

  function renderMarkdown(container, markdown) {
    const fragment = document.createDocumentFragment();

    for (const block of parseMarkdown(markdown)) {
      if (block.type === 'paragraph') {
        const paragraph = document.createElement('p');
        appendInline(paragraph, block.lines.join('\n'));
        fragment.appendChild(paragraph);
        continue;
      }

      if (block.type === 'heading') {
        const heading = document.createElement(`h${block.level}`);
        appendInline(heading, block.text);
        fragment.appendChild(heading);
        continue;
      }

      if (block.type === 'list') {
        const list = document.createElement(block.ordered ? 'ol' : 'ul');
        for (const item of block.items) {
          const listItem = document.createElement('li');
          appendInline(listItem, item);
          list.appendChild(listItem);
        }
        fragment.appendChild(list);
        continue;
      }

      if (block.type === 'blockquote') {
        const quote = document.createElement('blockquote');
        appendInline(quote, block.lines.join('\n'));
        fragment.appendChild(quote);
        continue;
      }

      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = block.value;
      pre.appendChild(code);
      fragment.appendChild(pre);
    }

    container.replaceChildren(fragment);
  }

  const api = { parseInline, parseMarkdown, renderMarkdown };
  if (typeof globalThis !== 'undefined') globalThis.fukuMarkdown = api;
  if (typeof window !== 'undefined') window.renderMarkdown = renderMarkdown;
})();

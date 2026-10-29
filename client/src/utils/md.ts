/**
 * Markdown → sanitized HTML. Everything we render as HTML comes from an LLM or
 * from files agents wrote, so it goes through DOMPurify before it touches the
 * DOM.
 */

import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ gfm: true, breaks: true });

export function renderMarkdown(text: string): string {
  let html = '';
  try { html = marked.parse(text || '', { async: false }) as string; }
  catch { html = escapeHtml(text || ''); }
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'input'],
    FORBID_ATTR: ['onerror', 'onload', 'style'],
  });
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

// Open external links in a new tab, safely.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    const href = node.getAttribute('href') || '';
    if (/^https?:\/\//i.test(href)) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  }
});

export function sanitizeMarkdownUris(content: string): string {
  return content.replace(/javascript:[^\s)]+/gi, '#');
}

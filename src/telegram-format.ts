const TELEGRAM_HTML_LIMIT = 3500;
const TELEGRAM_PREVIEW_LIMIT = 3500;
const HTML_TAG_PATTERN = /(<\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?>/g;
const SELF_CLOSING_TAGS = new Set(["br"]);

export interface TelegramFormattedChunk {
  html: string;
  text: string;
}

export interface PreparedTelegramTextChunk {
  html: string;
  plainText: string;
}

function createPlaceholder(index: number): string {
  return `\u0000TG${index}\u0000`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeHtmlAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;");
}

function normalizeMarkdown(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

function protectPattern(
  input: string,
  placeholders: Map<string, string>,
  pattern: RegExp,
  replacer: (...args: string[]) => string
): string {
  return input.replace(pattern, (...args) => {
    const matchArgs = args.slice(0, -2) as string[];
    const placeholder = createPlaceholder(placeholders.size);
    placeholders.set(placeholder, replacer(...matchArgs));
    return placeholder;
  });
}

function formatInlineMarkdown(text: string): string {
  const placeholders = new Map<string, string>();
  let current = text;
  current = protectPattern(
    current,
    placeholders,
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+(?:\([^\s)]*\)[^\s)]*)*)\)/g,
    (_match, label: string, href: string) => `<a href="${escapeHtmlAttr(href)}">${escapeHtml(label)}</a>`
  );
  current = protectPattern(current, placeholders, /\|\|(.+?)\|\|/g, (_match, inner: string) => {
    return `<tg-spoiler>${escapeHtml(inner)}</tg-spoiler>`;
  });
  current = protectPattern(current, placeholders, /~~(.+?)~~/g, (_match, inner: string) => {
    return `<s>${escapeHtml(inner)}</s>`;
  });
  current = protectPattern(current, placeholders, /\*\*(.+?)\*\*/g, (_match, inner: string) => {
    return `<b>${escapeHtml(inner)}</b>`;
  });
  current = protectPattern(current, placeholders, /(^|[^\w*])\*([^\s*][^*\n]*?)\*(?!\*)/g, (_match, prefix: string, inner: string) => {
    return `${escapeHtml(prefix)}<i>${escapeHtml(inner)}</i>`;
  });
  current = protectPattern(current, placeholders, /(^|[^\w_])_([^\s_][^_\n]*?)_(?!_)/g, (_match, prefix: string, inner: string) => {
    return `${escapeHtml(prefix)}<i>${escapeHtml(inner)}</i>`;
  });
  current = escapeHtml(current);
  for (const [placeholder, value] of placeholders) {
    current = current.replaceAll(placeholder, value);
  }
  return current;
}

export function markdownToTelegramHtml(markdown: string): string {
  const normalized = normalizeMarkdown(markdown);
  if (!normalized) {
    return "";
  }

  const placeholders = new Map<string, string>();
  let current = normalized;

  current = protectPattern(current, placeholders, /```(?:([^\n]*)\n)?([\s\S]*?)```/g, (_match, language = "", body = "") => {
    const open = language.trim() ? `<pre><code class="language-${escapeHtmlAttr(language.trim())}">` : "<pre><code>";
    return `${open}${escapeHtml(body.replace(/\n$/, ""))}</code></pre>`;
  });

  current = protectPattern(current, placeholders, /`([^`]+)`/g, (_match, body = "") => {
    return `<code>${escapeHtml(body)}</code>`;
  });

  const lines = current.split("\n");
  const renderedLines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return "";
    }
    const headingMatch = trimmed.match(/^#{1,6}\s+(.+)$/);
    if (headingMatch) {
      return `<b>${escapeHtml(headingMatch[1]!.trim())}</b>`;
    }
    const blockquoteMatch = line.match(/^\s*>\s?(.*)$/);
    if (blockquoteMatch) {
      return `<blockquote>${formatInlineMarkdown(blockquoteMatch[1] ?? "")}</blockquote>`;
    }
    return formatInlineMarkdown(line);
  });

  current = renderedLines.join("\n");
  for (const [placeholder, value] of placeholders) {
    current = current.replaceAll(placeholder, value);
  }
  return current;
}

function decodeHtmlEntity(entity: string): string {
  switch (entity) {
    case "&lt;":
      return "<";
    case "&gt;":
      return ">";
    case "&amp;":
      return "&";
    case "&quot;":
      return '"';
    default:
      return entity;
  }
}

export function stripTelegramHtml(html: string): string {
  return html
    .replace(/<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_match, href: string, label: string) => {
      const normalizedLabel = stripTelegramHtml(label);
      const normalizedHref = decodeHtmlEntity(href);
      return normalizedLabel && normalizedLabel !== normalizedHref
        ? `${normalizedLabel} (${normalizedHref})`
        : normalizedHref;
    })
    .replace(/<blockquote>([\s\S]*?)<\/blockquote>/gi, (_match, content: string) => {
      return stripTelegramHtml(content)
        .split("\n")
        .map((line) => (line ? `> ${line}` : ">"))
        .join("\n");
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(lt|gt|amp|quot);/g, (entity) => decodeHtmlEntity(entity))
    .trim();
}

function findEntityEnd(text: string, start: number): number {
  if (text[start] !== "&") {
    return -1;
  }
  const end = text.indexOf(";", start + 1);
  if (end === -1) {
    return -1;
  }
  const body = text.slice(start + 1, end);
  if (!body) {
    return -1;
  }
  if (body.startsWith("#")) {
    const numeric = body.slice(1);
    if (!numeric) {
      return -1;
    }
    if ((numeric.startsWith("x") || numeric.startsWith("X")) && /^[xX][0-9A-Fa-f]+$/.test(numeric)) {
      return end;
    }
    if (/^\d+$/.test(numeric)) {
      return end;
    }
    return -1;
  }
  return /^[A-Za-z0-9]+$/.test(body) ? end : -1;
}

function findSafeSplitIndex(text: string, maxLength: number): number {
  if (text.length <= maxLength) {
    return text.length;
  }
  const bounded = Math.max(1, Math.floor(maxLength));
  const lastAmpersand = text.lastIndexOf("&", bounded - 1);
  if (lastAmpersand === -1) {
    return bounded;
  }
  const lastSemicolon = text.lastIndexOf(";", bounded - 1);
  if (lastSemicolon > lastAmpersand) {
    return bounded;
  }
  const entityEnd = findEntityEnd(text, lastAmpersand);
  if (entityEnd === -1 || entityEnd < bounded) {
    return bounded;
  }
  return lastAmpersand;
}

function closeSuffix(tags: Array<{ closeTag: string }>): string {
  return tags
    .slice()
    .reverse()
    .map((tag) => tag.closeTag)
    .join("");
}

function closeSuffixLength(tags: Array<{ closeTag: string }>): number {
  return tags.reduce((total, tag) => total + tag.closeTag.length, 0);
}

function popTag(tags: Array<{ name: string; closeTag: string }>, name: string): void {
  for (let index = tags.length - 1; index >= 0; index -= 1) {
    if (tags[index]?.name === name) {
      tags.splice(index, 1);
      return;
    }
  }
}

export function splitTelegramHtmlChunks(html: string, limit = TELEGRAM_HTML_LIMIT): string[] {
  if (!html.trim()) {
    return [];
  }
  if (html.length <= limit) {
    return [html];
  }

  const tags: Array<{ name: string; openTag: string; closeTag: string }> = [];
  const chunks: string[] = [];
  let current = "";
  let chunkHasPayload = false;
  let lastIndex = 0;

  const resetCurrent = () => {
    current = tags.map((tag) => tag.openTag).join("");
    chunkHasPayload = false;
  };

  const flushCurrent = () => {
    if (!chunkHasPayload) {
      return;
    }
    chunks.push(`${current}${closeSuffix(tags)}`);
    resetCurrent();
  };

  const appendText = (segment: string) => {
    let remaining = segment;
    while (remaining.length > 0) {
      const available = limit - current.length - closeSuffixLength(tags);
      if (available <= 0) {
        if (!chunkHasPayload) {
          throw new Error(`Telegram HTML chunk limit exceeded by tag overhead (limit=${limit})`);
        }
        flushCurrent();
        continue;
      }
      if (remaining.length <= available) {
        current += remaining;
        chunkHasPayload = true;
        break;
      }
      const splitAt = findSafeSplitIndex(remaining, available);
      if (splitAt <= 0) {
        if (!chunkHasPayload) {
          throw new Error(`Telegram HTML chunk limit exceeded by leading entity (limit=${limit})`);
        }
        flushCurrent();
        continue;
      }
      current += remaining.slice(0, splitAt);
      chunkHasPayload = true;
      remaining = remaining.slice(splitAt);
      flushCurrent();
    }
  };

  resetCurrent();
  HTML_TAG_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = HTML_TAG_PATTERN.exec(html)) !== null) {
    const rawTag = match[0];
    const tagStart = match.index;
    const tagEnd = HTML_TAG_PATTERN.lastIndex;
    const isClosing = match[1] === "</";
    const tagName = match[2]?.toLowerCase() ?? "";
    const isSelfClosing = !isClosing && (SELF_CLOSING_TAGS.has(tagName) || rawTag.trimEnd().endsWith("/>"));

    appendText(html.slice(lastIndex, tagStart));
    if (!isClosing) {
      const nextCloseLength = isSelfClosing ? 0 : `</${tagName}>`.length;
      if (chunkHasPayload && current.length + rawTag.length + closeSuffixLength(tags) + nextCloseLength > limit) {
        flushCurrent();
      }
    }

    current += rawTag;
    if (isSelfClosing) {
      chunkHasPayload = true;
    }
    if (isClosing) {
      popTag(tags, tagName);
    } else if (!isSelfClosing) {
      tags.push({
        name: tagName,
        openTag: rawTag,
        closeTag: `</${tagName}>`
      });
    }
    lastIndex = tagEnd;
  }

  appendText(html.slice(lastIndex));
  flushCurrent();
  return chunks.length > 0 ? chunks : [html];
}

export function markdownToTelegramChunks(markdown: string, limit = TELEGRAM_HTML_LIMIT): TelegramFormattedChunk[] {
  const html = markdownToTelegramHtml(markdown);
  if (!html.trim()) {
    const text = normalizeMarkdown(markdown);
    return text ? [{ html: "", text }] : [];
  }
  return splitTelegramHtmlChunks(html, limit).map((chunkHtml) => ({
    html: chunkHtml,
    text: stripTelegramHtml(chunkHtml) || normalizeMarkdown(markdown)
  }));
}

export function renderTelegramPreview(markdown: string, limit = TELEGRAM_PREVIEW_LIMIT): TelegramFormattedChunk | undefined {
  return markdownToTelegramChunks(markdown, limit)[0];
}

export function splitPlainText(text: string, limit = TELEGRAM_HTML_LIMIT): string[] {
  const normalized = normalizeMarkdown(text);
  if (!normalized) {
    return ["(empty response)"];
  }
  const chunks: string[] = [];
  let remaining = normalized;
  while (remaining.length > limit) {
    let splitIndex = remaining.lastIndexOf("\n", limit);
    if (splitIndex < limit * 0.5) {
      splitIndex = remaining.lastIndexOf(" ", limit);
    }
    if (splitIndex < limit * 0.5) {
      splitIndex = limit;
    }
    chunks.push(remaining.slice(0, splitIndex).trim());
    remaining = remaining.slice(splitIndex).trim();
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
}

export function prepareTelegramTextChunks(markdown: string, limit = TELEGRAM_HTML_LIMIT): PreparedTelegramTextChunk[] {
  const chunks = markdownToTelegramChunks(markdown, limit);
  if (chunks.length > 0) {
    return chunks.map((chunk) => ({
      html: chunk.html,
      plainText: chunk.text
    }));
  }

  return splitPlainText(markdown, limit).map((chunk) => ({
    html: "",
    plainText: chunk
  }));
}

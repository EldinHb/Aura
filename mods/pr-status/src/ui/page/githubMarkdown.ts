// GitHub bodies mix markdown with HTML (comments, <img>, <details>, <br>, …). Aura's renderer
// shows raw HTML as text, and should never be handed it; so before rendering, the HTML GitHub
// users write is turned into markdown, and every other tag is dropped, keeping its text. Code
// (fenced blocks and inline code spans) is left exactly as written.

/** An https URL that can stand as a markdown destination as it is (no space, quote, bracket or backslash), else null. */
const https = (url: string | undefined) => (url && /^https:\/\/[^\s"'<>()\[\]\\`]+$/i.test(url) ? url : null);

/** The attributes of a tag's source, by lower-case name. */
function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  return out;
}

/** Text for an image's alt or a link's text: every backslash and markdown delimiter escaped, so it stays text. */
const escapeText = (text: string) => text.replace(/[\\`*_{}\[\]()#+\-.!<>|~"]/g, "\\$&");

/** One stretch of text outside code: its HTML as markdown, no tags left. */
function convert(text: string): string {
  return text
    // Comments, also one left open.
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    // Images: https only, as markdown images.
    .replace(/<img\b[^>]*>/gi, (tag) => {
      const a = attributes(tag);
      const src = https(a.src);
      return src ? `![${escapeText(a.alt ?? "")}](${src})` : "";
    })
    .replace(/<br\s*\/?>/gi, "  \n")
    // <details>: the summary in bold, then the content (the renderer has no collapsible block).
    .replace(/<summary\b[^>]*>([\s\S]*?)<\/summary>/gi, (_m, inner: string) => `\n**${inner.trim()}**\n\n`)
    .replace(/<\/?details\b[^>]*>/gi, "\n")
    .replace(/<(b|strong)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner: string) => `**${inner}**`)
    .replace(/<(i|em)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner: string) => `*${inner}*`)
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, inner: string) => `\`${inner.replace(/`/g, "")}\``)
    // Links: https only, as markdown links; others keep their text.
    .replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_m, attrs: string, inner: string) => {
      const href = https(attributes(attrs).href);
      return href ? `[${escapeText(inner)}](${href})` : inner;
    })
    // Every other tag goes; its text stays (<sub>, <sup>, <kbd>, <p>, <div>, <script>, …).
    .replace(/<\/?[A-Za-z][^<>]*>/g, "")
    // A stray "<" that could start a tag after all: not as markup.
    .replace(/<(?=[A-Za-z!/?])/g, "&lt;");
}

/** `text` with its HTML turned into markdown and no tags left outside code. */
export function githubMarkdown(text: string): string {
  // Fenced code blocks and inline code spans pass through untouched.
  const parts = text.split(/(^ {0,3}(?:```|~~~)[^\n]*\n[\s\S]*?(?:^ {0,3}(?:```|~~~)[^\n]*$|(?![\s\S]))|`[^`\n]*`)/m);
  return parts.map((part, i) => (i % 2 === 1 ? part : convert(part))).join("");
}

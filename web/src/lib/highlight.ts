// Syntax highlighting with Shiki, loaded on demand. Returns one HTML string per line so the
// file view and blame can lay lines out in their own rows. Light and dark colours are both
// emitted as CSS variables (--shiki-light / --shiki-dark) and picked by the theme.

const MAX_HIGHLIGHT_BYTES = 400_000;

const escape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function plainLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines.map(escape);
}

export async function highlightLines(text: string, lang: string): Promise<string[]> {
  if (lang === "text" || text.length > MAX_HIGHLIGHT_BYTES) return plainLines(text);
  try {
    const { codeToHtml } = await import("shiki");
    const html = await codeToHtml(text, {
      lang,
      themes: { light: "github-light", dark: "github-dark" },
      defaultColor: false,
    });
    const doc = new DOMParser().parseFromString(html, "text/html");
    const lines = Array.from(doc.querySelectorAll("span.line"), (l) => l.innerHTML);
    const expected = plainLines(text).length;
    return lines.length >= expected ? lines.slice(0, expected) : plainLines(text);
  } catch {
    return plainLines(text);
  }
}

// Content classification for the file view.

/** Same rule as the server's diff: a NUL byte in the first 8000 bytes means binary. */
export function isBinary(data: Uint8Array): boolean {
  const n = Math.min(data.length, 8000);
  for (let i = 0; i < n; i++) if (data[i] === 0) return true;
  return false;
}

const IMAGE: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", svg: "image/svg+xml", ico: "image/x-icon", avif: "image/avif",
};
export const imageType = (path: string) => IMAGE[ext(path)];

export const isMarkdown = (path: string) => /\.(md|markdown|mdx)$/i.test(path);

export function ext(path: string): string {
  const base = path.split("/").pop() ?? "";
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1).toLowerCase() : base.toLowerCase();
}

const LANG: Record<string, string> = {
  rs: "rust", ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript",
  cjs: "javascript", json: "json", toml: "toml", yaml: "yaml", yml: "yaml", md: "markdown",
  py: "python", go: "go", java: "java", kt: "kotlin", c: "c", h: "c", cc: "cpp", cpp: "cpp",
  hpp: "cpp", cs: "csharp", rb: "ruby", php: "php", swift: "swift", sh: "bash", bash: "bash",
  zsh: "bash", ps1: "powershell", sql: "sql", html: "html", css: "css", scss: "scss",
  proto: "proto", dockerfile: "dockerfile", makefile: "makefile", xml: "xml", vue: "vue",
  svelte: "svelte", lua: "lua", dart: "dart", ex: "elixir", exs: "elixir", hs: "haskell",
  tf: "hcl", nix: "nix", zig: "zig", csproj: "xml", gradle: "groovy",
};

/** Shiki language id for a path, or "text". */
export function languageOf(path: string): string {
  const base = (path.split("/").pop() ?? "").toLowerCase();
  if (base === "dockerfile" || base.startsWith("dockerfile.")) return "dockerfile";
  if (base === "makefile") return "makefile";
  return LANG[ext(path)] ?? "text";
}

// BeeGit object ids (SPEC 4.2): 34 bytes = algorithm (1 = BLAKE3) | kind | 32-byte digest.
// Text form: kind letter, algorithm digit, 64 lowercase hex digits, e.g. "c1ab…".

const LETTER: Record<number, string> = { 1: "b", 2: "t", 3: "c", 4: "m" };
const KIND: Record<string, number> = { b: 1, t: 2, c: 3, m: 4 };

export function toHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/** Text form of a 34-byte id; "" for empty bytes. */
export function idText(b: Uint8Array): string {
  if (b.length === 0) return "";
  const letter = LETTER[b[1]] ?? "x";
  return `${letter}${b[0]}${toHex(b.subarray(2))}`;
}

/** The 34 bytes of a full text id (throws on malformed input). */
export function idBytes(text: string): Uint8Array {
  const m = /^([btcm])1([0-9a-f]{64})$/.exec(text);
  if (!m) throw new Error(`not a full BeeGit id: ${text}`);
  const out = new Uint8Array(34);
  out[0] = 1;
  out[1] = KIND[m[1]];
  for (let i = 0; i < 32; i++) out[2 + i] = parseInt(m[2].slice(i * 2, i * 2 + 2), 16);
  return out;
}

export const isFullChangesetId = (s: string) => /^c1[0-9a-f]{64}$/.test(s);

/** Human short form, as the CLI prints it: kind + algorithm + 12 hex digits. */
export const shortId = (text: string) => text.slice(0, 14);

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: false });
export const utf8 = (s: string) => enc.encode(s);
export const fromUtf8 = (b: Uint8Array) => dec.decode(b);

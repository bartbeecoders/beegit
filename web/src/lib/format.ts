// Dates in the author's own time zone, git style (same as the CLI: "2026-10-16 11:42:26
// +0200"), plus a short relative form for listings.

export type Time = { seconds: number; tz: number };

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

export function formatTime(t: Time | null): string {
  if (!t) return "";
  const local = new Date((t.seconds + t.tz * 60) * 1000);
  const sign = t.tz < 0 ? "-" : "+";
  const off = Math.abs(t.tz);
  return (
    `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())} ` +
    `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())} ` +
    `${sign}${pad(Math.floor(off / 60))}${pad(off % 60)}`
  );
}

export function relativeTime(unixSeconds: number, now = Date.now() / 1000): string {
  const d = Math.round(now - unixSeconds);
  if (unixSeconds <= 0) return "at the beginning";
  if (d < 45) return "just now";
  const units: [number, string][] = [
    [60, "minute"],
    [3600, "hour"],
    [86400, "day"],
    [86400 * 30, "month"],
    [86400 * 365, "year"],
  ];
  let unit = units[0];
  for (const u of units) if (d >= u[0]) unit = u;
  const n = Math.max(1, Math.round(d / unit[0]));
  return `${n} ${unit[1]}${n === 1 ? "" : "s"} ago`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KiB", "MiB", "GiB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** "Name <email>" → "Name". */
export const authorName = (a: string) => a.replace(/\s*<[^>]*>\s*$/, "") || a;

export const firstLine = (s: string) => s.split("\n", 1)[0];

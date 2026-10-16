import { describe, expect, it } from "vitest";
import { authorName, formatBytes, formatTime, relativeTime } from "./format";

describe("format", () => {
  it("prints the time in its own offset like the CLI", () => {
    expect(formatTime({ seconds: 1_700_000_000, tz: -90 })).toBe("2023-11-14 20:43:20 -0130");
    expect(formatTime({ seconds: 1_700_000_000, tz: 120 })).toBe("2023-11-15 00:13:20 +0200");
    expect(formatTime({ seconds: 0, tz: 0 })).toBe("1970-01-01 00:00:00 +0000");
  });
  it("relative times", () => {
    expect(relativeTime(1000, 1010)).toBe("just now");
    expect(relativeTime(0, 1000)).toBe("at the beginning");
    expect(relativeTime(1000, 1000 + 3 * 86400)).toBe("3 days ago");
  });
  it("sizes and names", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(20 * 1024 * 1024)).toBe("20 MiB");
    expect(authorName("Ada Lovelace <ada@example.com>")).toBe("Ada Lovelace");
  });
});

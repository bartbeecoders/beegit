import { describe, expect, it } from "vitest";
import { idBytes, idText, shortId } from "./ids";

describe("ids", () => {
  it("round-trips the text form", () => {
    const t = "c1" + "ab".repeat(32);
    const b = idBytes(t);
    expect(b.length).toBe(34);
    expect(b[0]).toBe(1);
    expect(b[1]).toBe(3);
    expect(idText(b)).toBe(t);
    expect(shortId(t)).toBe("c1abababababab");
  });
  it("rejects malformed ids", () => {
    expect(() => idBytes("c1abc")).toThrow();
    expect(() => idBytes("x1" + "00".repeat(32))).toThrow();
  });
});

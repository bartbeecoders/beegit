import { describe, expect, it } from "vitest";
import { frameRewriter, renameTrailerKey } from "./fetch";

const enc = new TextEncoder();
const frame = (flag: number, payload: Uint8Array) => {
  const f = new Uint8Array(5 + payload.length);
  f[0] = flag;
  new DataView(f.buffer).setUint32(1, payload.length);
  f.set(payload, 5);
  return f;
};

async function run(chunks: Uint8Array[]): Promise<Uint8Array> {
  const out: Uint8Array[] = [];
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      chunks.forEach((x) => c.enqueue(x));
      c.close();
    },
  }).pipeThrough(frameRewriter());
  for await (const x of stream as unknown as AsyncIterable<Uint8Array>) out.push(x);
  const total = out.reduce((n, x) => n + x.length, 0);
  const all = new Uint8Array(total);
  let o = 0;
  for (const x of out) {
    all.set(x, o);
    o += x.length;
  }
  return all;
}

describe("gRPC-Web detail rename", () => {
  it("renames only the details key", () => {
    const t = enc.encode("grpc-status:16\r\ngrpc-status-details-bin:AAA=\r\nbeegit-tier:server\r\n");
    expect(new TextDecoder().decode(renameTrailerKey(t))).toBe(
      "grpc-status:16\r\nbeegit-error-detail-bin:AAA=\r\nbeegit-tier:server\r\n",
    );
  });

  it("rewrites the trailer frame under any chunking and keeps data frames", async () => {
    const data = frame(0, new Uint8Array([1, 2, 3, 4]));
    const trailer = frame(0x80, enc.encode("grpc-status:5\r\ngrpc-status-details-bin:Zm9v\r\n"));
    const wire = new Uint8Array([...data, ...trailer]);
    const expected = new Uint8Array([
      ...data,
      ...frame(0x80, enc.encode("grpc-status:5\r\nbeegit-error-detail-bin:Zm9v\r\n")),
    ]);
    for (const size of [wire.length, 1, 3, 7]) {
      const chunks: Uint8Array[] = [];
      for (let i = 0; i < wire.length; i += size) chunks.push(wire.slice(i, i + size));
      expect(Array.from(await run(chunks))).toEqual(Array.from(expected));
    }
  });
});

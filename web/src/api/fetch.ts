// BeeGit sends its own ErrorDetail message in `grpc-status-details-bin`; gRPC clients such as
// Connect-ES expect a google.rpc.Status there and fail with DataLoss when it does not decode.
// This fetch wrapper renames that key to `beegit-error-detail-bin` — in the response headers
// (trailers-only errors) and in the gRPC-Web trailer frame inside the body — so the standard
// status and message come through and BeeGit's detail stays readable (see errorDetail()).

const FROM = "grpc-status-details-bin";
const TO = "beegit-error-detail-bin";
const TRAILERS = 0x80;
const enc = new TextEncoder();
const dec = new TextDecoder();

/** Rewrite the trailer block of a gRPC-Web trailer frame payload. */
export function renameTrailerKey(payload: Uint8Array): Uint8Array {
  const text = dec.decode(payload);
  if (!text.toLowerCase().includes(FROM)) return payload;
  const out = text
    .split("\r\n")
    .map((line) => (line.toLowerCase().startsWith(`${FROM}:`) ? TO + line.slice(FROM.length) : line))
    .join("\r\n");
  return enc.encode(out);
}

/** A stream transformer over gRPC-Web frames: data frames pass through, the trailer frame
 * gets [renameTrailerKey]. Works for any chunking. */
export function frameRewriter(): TransformStream<Uint8Array, Uint8Array> {
  let buf = new Uint8Array(0);
  const append = (chunk: Uint8Array) => {
    const b = new Uint8Array(buf.length + chunk.length);
    b.set(buf);
    b.set(chunk, buf.length);
    buf = b;
  };
  return new TransformStream({
    transform(chunk, ctl) {
      append(chunk);
      for (;;) {
        if (buf.length < 5) return;
        const len = new DataView(buf.buffer, buf.byteOffset + 1, 4).getUint32(0);
        if (buf.length < 5 + len) return;
        const flag = buf[0];
        const payload = buf.subarray(5, 5 + len);
        if (flag & TRAILERS) {
          const p = renameTrailerKey(payload);
          const f = new Uint8Array(5 + p.length);
          f[0] = flag;
          new DataView(f.buffer).setUint32(1, p.length);
          f.set(p, 5);
          ctl.enqueue(f);
        } else {
          ctl.enqueue(buf.slice(0, 5 + len));
        }
        buf = buf.slice(5 + len);
      }
    },
    flush(ctl) {
      if (buf.length) ctl.enqueue(buf);
    },
  });
}

export const beegitFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  const headers = new Headers(res.headers);
  const detail = headers.get(FROM);
  if (detail !== null) {
    headers.delete(FROM);
    headers.set(TO, detail);
  }
  const body = res.body && (res.headers.get("content-type") ?? "").startsWith("application/grpc-web")
    ? res.body.pipeThrough(frameRewriter())
    : res.body;
  return new Response(body, { status: res.status, statusText: res.statusText, headers });
};

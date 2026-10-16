// gRPC-Web clients for the beegit.v1 services. Calls go to the page's own origin: in
// production the Cloudflare Tunnel routes /beegit.v1.* to beegit-server, in development the
// Vite dev server proxies them (vite.config.ts).
import { Code, ConnectError, createClient, type Interceptor } from "@connectrpc/connect";
import { createGrpcWebTransport } from "@connectrpc/connect-web";
import {
  AdminService,
  AuthService,
  ObjectService,
  QueryService,
  RefService,
} from "../gen/beegit/v1/beegit_pb";
import { fromBinary } from "@bufbuild/protobuf";
import { ErrorDetailSchema } from "../gen/beegit/v1/beegit_pb";
import { beegitFetch } from "./fetch";
import { getToken, setSession } from "./session";

const bearer: Interceptor = (next) => async (req) => {
  const t = getToken();
  if (t) req.header.set("authorization", `Bearer ${t}`);
  try {
    return await next(req);
  } catch (e) {
    // An expired or revoked token: drop the session so the UI asks to sign in again.
    if (t && e instanceof ConnectError && e.code === Code.Unauthenticated) setSession(null);
    throw e;
  }
};

const transport = createGrpcWebTransport({
  baseUrl: window.location.origin,
  useBinaryFormat: true,
  interceptors: [bearer],
  fetch: beegitFetch,
});

export const api = {
  objects: createClient(ObjectService, transport),
  query: createClient(QueryService, transport),
  refs: createClient(RefService, transport),
  auth: createClient(AuthService, transport),
  admin: createClient(AdminService, transport),
};

/** BeeGit's own error code (e.g. NOT_FOUND, REDACTED) from the renamed detail trailer. */
export function errorDetail(e: unknown): { code: string; message: string } | null {
  if (!(e instanceof ConnectError)) return null;
  const raw = e.metadata.get("beegit-error-detail-bin");
  if (!raw) return null;
  try {
    const bin = Uint8Array.from(atob(raw.replace(/=+$/, "").padEnd(Math.ceil(raw.replace(/=+$/, "").length / 4) * 4, "=")), (c) => c.charCodeAt(0));
    const d = fromBinary(ErrorDetailSchema, bin);
    return { code: d.code, message: d.message };
  } catch {
    return null;
  }
}

/** One-line message for an error from a call: BeeGit's code when present, else gRPC's. */
export function errorText(e: unknown): string {
  if (e instanceof ConnectError) {
    const d = errorDetail(e);
    return d ? `${d.code}: ${d.message || e.rawMessage}` : `${Code[e.code] ?? e.code}: ${e.rawMessage}`;
  }
  return e instanceof Error ? e.message : String(e);
}

export const isCode = (e: unknown, c: Code) => e instanceof ConnectError && e.code === c;
export { Code };

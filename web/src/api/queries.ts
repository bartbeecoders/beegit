// React Query hooks over the beegit.v1 RPCs. Everything addressed by an object id is
// immutable, so those queries never go stale; only ref resolution and listings refresh.
import { useInfiniteQuery, useQueries, useQuery } from "@tanstack/react-query";
import type {
  DiffItem,
  EntryInfo,
  FilteredChangeset,
  LogEntry,
  MetaView,
} from "../gen/beegit/v1/beegit_pb";
import { api } from "./client";
import { fromUtf8, idBytes, idText, isFullChangesetId, utf8 } from "./ids";

const forever = { staleTime: Infinity, gcTime: 30 * 60_000 } as const;

export function useServerInfo() {
  return useQuery({
    queryKey: ["serverInfo"],
    queryFn: () => api.objects.getServerInfo({}),
    staleTime: 5 * 60_000,
  });
}

export function useWhoAmI(enabled = true) {
  return useQuery({
    queryKey: ["whoami"],
    queryFn: () => api.auth.whoAmI({}),
    enabled,
    staleTime: 60_000,
  });
}

/** A revision (ref name, `main~2`, id prefix, `git:<sha>`, full id) → full changeset id. */
export function useResolve(rev: string | undefined) {
  return useQuery({
    queryKey: ["resolve", rev],
    enabled: !!rev,
    queryFn: async () => {
      if (rev && isFullChangesetId(rev)) return rev;
      const r = await api.query.resolve({ revision: rev! });
      return idText(r.changeset);
    },
    staleTime: isFullChangesetId(rev ?? "") ? Infinity : 10_000,
  });
}

export type TreeEntry = { name: string; mode: number; id: string; size: number };

export const MODE = { file: 1, exec: 2, symlink: 3, tree: 4 } as const;

function entryOf(name: string, e: EntryInfo | undefined): TreeEntry {
  return {
    name,
    mode: e?.mode ?? 0,
    id: e ? idText(e.id) : "",
    size: Number(e?.size ?? 0n),
  };
}

/** Directory listing at `path` ("" = root) of changeset `cs`. */
export function useTree(cs: string | undefined, path: string) {
  return useQuery({
    queryKey: ["tree", cs, path],
    enabled: !!cs,
    ...forever,
    queryFn: async () => {
      const r = await api.query.listTree({ changeset: idBytes(cs!), path: utf8(path) });
      return r.entries.map((e) => entryOf(fromUtf8(e.name), e.entry));
    },
  });
}

export type FileContent = { entry: TreeEntry; data: Uint8Array };

/** Full content of the file at `path` (streamed ReadPath, reassembled). */
export function useFile(cs: string | undefined, path: string, enabled = true) {
  return useQuery({
    queryKey: ["file", cs, path],
    enabled: !!cs && enabled,
    ...forever,
    queryFn: async (): Promise<FileContent> => {
      let entry: EntryInfo | undefined;
      const parts: Uint8Array[] = [];
      let total = 0;
      for await (const chunk of api.query.readPath({ changeset: idBytes(cs!), path: utf8(path) })) {
        if (chunk.entry) entry = chunk.entry;
        parts.push(chunk.data);
        total += chunk.data.length;
      }
      const data = new Uint8Array(total);
      let off = 0;
      for (const p of parts) {
        data.set(p, off);
        off += p.length;
      }
      return { entry: entryOf(path.split("/").pop() ?? "", entry), data };
    },
  });
}

export type Change = {
  id: string;
  parents: string[];
  rootTree: string;
  changeId: string;
  filtered: boolean;
  delta: { path: string; op: number; mode: number; id: string; size: number }[];
  meta: Meta;
};

export type Meta = {
  redacted: boolean;
  author: string;
  authorTime: { seconds: number; tz: number } | null;
  committer: string | null;
  committerTime: { seconds: number; tz: number } | null;
  creator: string;
  message: string;
};

function metaOf(m: MetaView | undefined): Meta {
  const time = (t: { seconds: bigint; tzOffsetMinutes: bigint } | undefined) =>
    t ? { seconds: Number(t.seconds), tz: Number(t.tzOffsetMinutes) } : null;
  return {
    redacted: m?.redacted ?? false,
    author: fromUtf8(m?.author ?? new Uint8Array()),
    authorTime: time(m?.authorTime),
    committer: m?.committer ? fromUtf8(m.committer) : null,
    committerTime: m?.committer ? time(m?.committerTime) : null,
    creator: fromUtf8(m?.creator ?? new Uint8Array()),
    message: fromUtf8(m?.message ?? new Uint8Array()),
  };
}

function changeOf(e: LogEntry): Change {
  const view = e.changeset?.view;
  const v: FilteredChangeset | undefined = view?.case === "filteredView" ? view.value : undefined;
  return {
    id: idText(e.id),
    parents: (v?.parents ?? []).map(idText),
    rootTree: v ? idText(v.rootTree) : "",
    changeId: v ? Array.from(v.changeId, (x) => x.toString(16).padStart(2, "0")).join("") : "",
    filtered: v?.filtered ?? false,
    delta: (v?.delta ?? []).map((d) => ({
      path: fromUtf8(d.path),
      op: d.op,
      mode: d.mode,
      id: idText(d.id),
      size: Number(d.size),
    })),
    meta: metaOf(e.meta),
  };
}

const PAGE = 50;

/** Paginated history from `cs`, optionally limited to `path`. */
export function useLog(cs: string | undefined, path: string, firstParent: boolean) {
  return useInfiniteQuery({
    queryKey: ["log", cs, path, firstParent],
    enabled: !!cs,
    ...forever,
    initialPageParam: new Uint8Array() as Uint8Array<ArrayBufferLike>,
    queryFn: async ({ pageParam }) => {
      const r = await api.query.log({
        from: idBytes(cs!),
        path: path ? utf8(path) : undefined,
        firstParentOnly: firstParent,
        limit: PAGE,
        pageToken: pageParam,
        structured: true,
      });
      return { entries: r.entries.map(changeOf), next: r.nextPageToken };
    },
    getNextPageParam: (last) => (last.next.length ? last.next : undefined),
  });
}

/** One changeset with its metadata (Log from it, limit 1). */
async function fetchChange(id: string): Promise<Change> {
  const r = await api.query.log({ from: idBytes(id), limit: 1, structured: true });
  if (!r.entries.length) throw new Error(`changeset ${id} not found`);
  return changeOf(r.entries[0]);
}

export function useChange(id: string | undefined) {
  return useQuery({ queryKey: ["change", id], enabled: !!id, ...forever, queryFn: () => fetchChange(id!) });
}

/** Many changesets (blame origins), each cached individually. */
export function useChanges(ids: string[]) {
  return useQueries({
    queries: ids.map((id) => ({ queryKey: ["change", id], ...forever, queryFn: () => fetchChange(id) })),
  });
}

export type FileDiff = {
  path: string;
  oldEntry: TreeEntry | null;
  newEntry: TreeEntry | null;
  binary: boolean;
  hunks: { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }[];
};

function diffOf(d: DiffItem): FileDiff {
  const path = fromUtf8(d.path);
  return {
    path,
    oldEntry: d.oldEntry ? entryOf(path, d.oldEntry) : null,
    newEntry: d.newEntry ? entryOf(path, d.newEntry) : null,
    binary: d.binary,
    hunks: d.hunks.map((h) => ({
      oldStart: h.oldStart,
      oldLines: h.oldLines,
      newStart: h.newStart,
      newLines: h.newLines,
      lines: h.lines.map(fromUtf8),
    })),
  };
}

/** File changes from `a` (undefined = the empty tree) to `b`, with content hunks. */
export function useDiff(a: string | undefined, b: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ["diff", a ?? "", b],
    enabled: !!b && enabled,
    ...forever,
    queryFn: async () => {
      const out: FileDiff[] = [];
      for await (const d of api.query.diff({
        a: a ? idBytes(a) : new Uint8Array(),
        b: idBytes(b!),
        includeContentHunks: true,
      })) {
        out.push(diffOf(d));
      }
      return out;
    },
  });
}

export function useBlame(cs: string | undefined, path: string) {
  return useQuery({
    queryKey: ["blame", cs, path],
    enabled: !!cs,
    ...forever,
    queryFn: async () => {
      const r = await api.query.blame({ changeset: idBytes(cs!), path: utf8(path) });
      return r.ranges.map((x) => ({
        start: x.startLine,
        count: x.lineCount,
        origin: idText(x.originChangeset),
        originStart: x.originStartLine,
      }));
    },
  });
}

export type RefInfo = { name: string; target: string; version: number; updatedAt: number };

export function useRefs(prefix = "") {
  return useQuery({
    queryKey: ["refs", prefix],
    staleTime: 10_000,
    queryFn: async () => {
      const out: RefInfo[] = [];
      let pageToken = "";
      for (;;) {
        const r = await api.refs.listRefs({ prefix, limit: 1000, pageToken });
        for (const x of r.refs) {
          out.push({
            name: x.name,
            target: idText(x.target),
            version: Number(x.version),
            updatedAt: Number(x.updatedAtUnixMs),
          });
        }
        if (!r.nextPageToken) return out;
        pageToken = r.nextPageToken;
      }
    },
  });
}

export function useRefLog(name: string) {
  return useQuery({
    queryKey: ["reflog", name],
    staleTime: 10_000,
    queryFn: async () => {
      const r = await api.refs.getRefLog({ name, fromVersion: 0n, limit: 10_000 });
      return r.entries.map((e) => ({
        version: Number(e.version),
        oldTarget: idText(e.oldTarget),
        newTarget: idText(e.newTarget),
        principal: e.principal,
        at: Number(e.atUnixMs),
        landed: e.landed.map((l) => idText(l.result)).filter(Boolean),
      }));
    },
  });
}

export function useMergeBase(a: string | undefined, b: string | undefined) {
  return useQuery({
    queryKey: ["mergeBase", a, b],
    enabled: !!a && !!b,
    ...forever,
    queryFn: async () => {
      const r = await api.query.mergeBase({ a: idBytes(a!), b: idBytes(b!) });
      return r.bases.map(idText);
    },
  });
}

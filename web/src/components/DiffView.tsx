// File diffs from the server's Diff RPC (content hunks), unified or side by side.
import { useState } from "react";
import { Link } from "react-router-dom";
import type { FileDiff } from "../api/queries";
import { urls } from "../lib/urls";

type Row = { kind: " " | "-" | "+"; text: string; old?: number; new?: number };

function rowsOf(h: FileDiff["hunks"][number]): Row[] {
  let o = h.oldStart;
  let n = h.newStart;
  return h.lines.map((l) => {
    const kind = (l[0] ?? " ") as Row["kind"];
    const text = l.slice(1).replace(/\r?\n$/, "");
    if (kind === "-") return { kind, text, old: o++ };
    if (kind === "+") return { kind, text, new: n++ };
    return { kind: " ", text, old: o++, new: n++ };
  });
}

/** Pair deletions with insertions for the split view. */
function splitRows(rows: Row[]): [Row | null, Row | null][] {
  const out: [Row | null, Row | null][] = [];
  for (let i = 0; i < rows.length; ) {
    if (rows[i].kind === " ") {
      out.push([rows[i], rows[i]]);
      i++;
      continue;
    }
    const del: Row[] = [];
    const ins: Row[] = [];
    while (i < rows.length && rows[i].kind === "-") del.push(rows[i++]);
    while (i < rows.length && rows[i].kind === "+") ins.push(rows[i++]);
    for (let k = 0; k < Math.max(del.length, ins.length); k++) out.push([del[k] ?? null, ins[k] ?? null]);
  }
  return out;
}

export function diffStats(d: FileDiff) {
  let add = 0;
  let del = 0;
  for (const h of d.hunks) for (const l of h.lines) l[0] === "+" ? add++ : l[0] === "-" ? del++ : 0;
  return { add, del };
}

function status(d: FileDiff): string {
  if (!d.oldEntry) return "added";
  if (!d.newEntry) return "deleted";
  if (d.oldEntry.mode !== d.newEntry.mode && d.oldEntry.id === d.newEntry.id) return "mode";
  return "modified";
}

const LARGE = 800;

function FileBlock({ d, split, repo, rev }: { d: FileDiff; split: boolean; repo: string; rev?: string }) {
  const { add, del } = diffStats(d);
  const [open, setOpen] = useState(add + del <= LARGE);
  const st = status(d);
  return (
    <section className="diff-file" id={`diff-${encodeURIComponent(d.path)}`}>
      <header className="diff-head">
        <button className="icon-btn" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? "▾" : "▸"}</button>
        <span className={`badge badge-${st}`}>{st}</span>
        {rev && d.newEntry ? <Link to={urls.blob(repo, rev, d.path)}><code>{d.path}</code></Link> : <code>{d.path}</code>}
        <span className="diff-stat"><span className="add">+{add}</span> <span className="del">−{del}</span></span>
      </header>
      {open && (d.binary ? (
        <div className="diff-note">Binary file — no line diff.</div>
      ) : d.hunks.length === 0 ? (
        <div className="diff-note">{st === "mode" ? "File mode changed." : "No content changes (or content not readable)."}</div>
      ) : (
        <table className={`diff ${split ? "split" : "unified"}`}>
          {split ? (
            <colgroup><col className="ln-col" /><col /><col className="ln-col" /><col /></colgroup>
          ) : (
            <colgroup><col className="ln-col" /><col className="ln-col" /><col /></colgroup>
          )}
          <tbody>
            {d.hunks.map((h, hi) => {
              const rows = rowsOf(h);
              return [
                <tr key={`h${hi}`} className="hunk-head">
                  <td colSpan={split ? 4 : 3}>@@ −{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@</td>
                </tr>,
                ...(split
                  ? splitRows(rows).map(([l, r], i) => (
                      <tr key={`${hi}-${i}`}>
                        <td className="ln">{l?.old ?? ""}</td>
                        <td className={`dc ${l ? (l.kind === "-" ? "del" : "") : "none"}`}>{l?.text}</td>
                        <td className="ln">{r?.new ?? ""}</td>
                        <td className={`dc ${r ? (r.kind === "+" ? "add" : "") : "none"}`}>{r?.text}</td>
                      </tr>
                    ))
                  : rows.map((r, i) => (
                      <tr key={`${hi}-${i}`} className={r.kind === "+" ? "add" : r.kind === "-" ? "del" : ""}>
                        <td className="ln">{r.old ?? ""}</td>
                        <td className="ln">{r.new ?? ""}</td>
                        <td className="dc"><span className="mark">{r.kind}</span>{r.text}</td>
                      </tr>
                    ))),
              ];
            })}
          </tbody>
        </table>
      ))}
    </section>
  );
}

export function DiffView({ diffs, repo, rev }: { diffs: FileDiff[]; repo: string; rev?: string }) {
  const [split, setSplit] = useState(() => localStorage.getItem("beegit.diff") === "split");
  const toggle = (v: boolean) => {
    setSplit(v);
    try {
      localStorage.setItem("beegit.diff", v ? "split" : "unified");
    } catch {
      /* ignore */
    }
  };
  const total = diffs.reduce(
    (acc, d) => {
      const s = diffStats(d);
      return { add: acc.add + s.add, del: acc.del + s.del };
    },
    { add: 0, del: 0 },
  );
  return (
    <div>
      <div className="diff-toolbar">
        <span>{diffs.length} file{diffs.length === 1 ? "" : "s"} changed, <span className="add">+{total.add}</span> <span className="del">−{total.del}</span></span>
        <div className="seg" role="group" aria-label="Diff layout">
          <button aria-pressed={!split} onClick={() => toggle(false)}>Unified</button>
          <button aria-pressed={split} onClick={() => toggle(true)}>Split</button>
        </div>
      </div>
      {diffs.map((d) => <FileBlock key={d.path} d={d} split={split} repo={repo} rev={rev} />)}
    </div>
  );
}

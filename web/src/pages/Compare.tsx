import { useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useDiff, useLog, useMergeBase, useResolve } from "../api/queries";
import { DiffView } from "../components/DiffView";
import { RepoTabs } from "../components/Nav";
import { Empty, ErrorBox, Id, Page, Spinner } from "../components/ui";
import { authorName, firstLine } from "../lib/format";
import { urls } from "../lib/urls";

/** /compare/<a>...<b>: what b has that a does not, diffed from their merge base. */
export function ComparePage() {
  const { repo = "", spec = "" } = useParams();
  const [aRev = "main", bRev = "main"] = spec.split("...");
  const navigate = useNavigate();
  const [a, setA] = useState(aRev);
  const [b, setB] = useState(bRev);
  const ra = useResolve(aRev);
  const rb = useResolve(bRev);
  const base = useMergeBase(ra.data, rb.data);
  const from = base.data?.[0] ?? ra.data;
  const diff = useDiff(from, rb.data, !!base.data);
  const log = useLog(rb.data, "", true);
  // Changesets on b's first-parent line after the merge base.
  const between = (log.data?.pages.flatMap((p) => p.entries) ?? []);
  const stop = between.findIndex((c) => c.id === from);
  const ahead = stop >= 0 ? between.slice(0, stop) : between;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    navigate(urls.compare(repo, a.trim(), b.trim()));
  };
  return (
    <Page>
      <RepoTabs repo={repo} rev={bRev} active="compare" />
      <form className="compare-form" onSubmit={submit}>
        <label>base <input value={a} onChange={(e) => setA(e.target.value)} spellCheck={false} /></label>
        <span>…</span>
        <label>compare <input value={b} onChange={(e) => setB(e.target.value)} spellCheck={false} /></label>
        <button className="btn">Compare</button>
      </form>
      {(ra.error || rb.error) && <ErrorBox error={ra.error ?? rb.error} title="Unknown revision" />}
      {base.error && <ErrorBox error={base.error} />}
      {(base.isLoading || diff.isLoading) && <Spinner />}
      {base.data && (
        <div className="muted small compare-meta">
          Merge base {from ? <Id id={from} to={urls.change(repo, from)} /> : "none"} ·{" "}
          {ra.data === rb.data ? "identical revisions" : `${ahead.length}${log.hasNextPage && stop < 0 ? "+" : ""} changeset(s) in ${bRev} not in ${aRev}`}
        </div>
      )}
      {ahead.length > 0 && (
        <ul className="change-list card flush compact">
          {ahead.slice(0, 50).map((c) => (
            <li key={c.id} className="change-row">
              <Id id={c.id} to={urls.change(repo, c.id)} />
              <span className="truncate">{firstLine(c.meta.message)}</span>
              <span className="muted small">{authorName(c.meta.author)}</span>
            </li>
          ))}
        </ul>
      )}
      {diff.error && <ErrorBox error={diff.error} />}
      {diff.data && (diff.data.length ? <DiffView diffs={diff.data} repo={repo} rev={rb.data} /> : <Empty>No differences.</Empty>)}
    </Page>
  );
}

import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useBlame, useChanges, useFile } from "../api/queries";
import { fromUtf8 } from "../api/ids";
import { useHighlighted } from "../components/CodeView";
import { Breadcrumbs, RepoTabs } from "../components/Nav";
import { ErrorBox, Page, Spinner } from "../components/ui";
import { languageOf } from "../lib/content";
import { authorName, firstLine, relativeTime } from "../lib/format";
import { urls } from "../lib/urls";
import { NotFoundPage } from "./Repos";
import { useRepoRoute } from "./route";

export function BlamePage() {
  const { repo, rev, path, cs, resolved, unknownRepo } = useRepoRoute();
  const blame = useBlame(cs, path);
  const file = useFile(cs, path);
  const text = file.data ? fromUtf8(file.data.data) : "";
  const lines = useHighlighted(text, languageOf(path));
  const origins = useMemo(() => [...new Set((blame.data ?? []).map((r) => r.origin))], [blame.data]);
  const changes = useChanges(origins);
  const byId = new Map(changes.flatMap((q) => (q.data ? [[q.data.id, q.data] as const] : [])));
  // Age shading: newest origin darkest.
  const times = [...byId.values()].map((c) => c.meta.authorTime?.seconds ?? 0);
  const [lo, hi] = [Math.min(...times, 0), Math.max(...times, 1)];
  if (unknownRepo) return <NotFoundPage what="Repository" />;
  return (
    <Page>
      <RepoTabs repo={repo} rev={rev} active="code" />
      <Breadcrumbs repo={repo} rev={rev} path={path} leafIsFile />
      <div className="row-gap">
        <Link className="btn btn-quiet" to={urls.blob(repo, rev, path)}>View file</Link>
        <Link className="btn btn-quiet" to={urls.log(repo, rev, path)}>History</Link>
      </div>
      {resolved.error && <ErrorBox error={resolved.error} />}
      {(blame.error || file.error) && <ErrorBox error={blame.error ?? file.error} />}
      {(blame.isLoading || file.isLoading) && <Spinner />}
      {blame.data && file.data && (
        <div className="card flush blame">
          {blame.data.map((r) => {
            const c = byId.get(r.origin);
            const age = c?.meta.authorTime ? (c.meta.authorTime.seconds - lo) / Math.max(1, hi - lo) : 0;
            return (
              <div className="blame-range" key={`${r.start}-${r.origin}`}>
                <div className="blame-info" style={{ borderLeftColor: `color-mix(in srgb, var(--accent) ${Math.round(20 + 80 * age)}%, transparent)` }}>
                  {c ? (
                    <>
                      <Link to={urls.change(repo, r.origin)} className="truncate">{firstLine(c.meta.message)}</Link>
                      <span className="muted small">{authorName(c.meta.author)} · {c.meta.authorTime ? relativeTime(c.meta.authorTime.seconds) : ""}</span>
                      {c.parents[0] && (
                        <Link className="small" to={urls.blame(repo, c.parents[0], path)} title="Blame before this change">↶ before</Link>
                      )}
                    </>
                  ) : (
                    <span className="muted small">…</span>
                  )}
                </div>
                <div className="code">
                  {Array.from({ length: r.count }, (_, k) => {
                    const n = r.start + k + 1;
                    return (
                      <div className="code-line" key={n} id={`L${n}`}>
                        <a className="ln" href={`#L${n}`}>{n}</a>
                        <span className="lc" dangerouslySetInnerHTML={{ __html: lines[n - 1] ?? " " }} />
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Page>
  );
}

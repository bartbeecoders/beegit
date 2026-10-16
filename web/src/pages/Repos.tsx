import { Link, Navigate, useParams } from "react-router-dom";
import { useLog, useRefs, useResolve, useServerInfo } from "../api/queries";
import { authorName, firstLine, relativeTime } from "../lib/format";
import { urls } from "../lib/urls";
import { ErrorBox, Page, Spinner } from "../components/ui";

/** Every repository the viewer can read. A BeeGit server hosts one today (plan B-FEAT-5). */
export function ReposPage() {
  const info = useServerInfo();
  if (info.isLoading) return <Page><Spinner /></Page>;
  if (info.error) return <Page><ErrorBox error={info.error} /></Page>;
  const repos = info.data ? [info.data.repo] : [];
  return (
    <Page title="Repositories">
      <div className="repo-list">
        {repos.map((r) => <RepoCard key={r} repo={r} />)}
      </div>
    </Page>
  );
}

function RepoCard({ repo }: { repo: string }) {
  const main = useResolve("main");
  const log = useLog(main.data, "", true);
  const refs = useRefs();
  const last = log.data?.pages[0]?.entries[0];
  return (
    <Link className="card repo-card" to={urls.tree(repo, "main")}>
      <div className="repo-card-head"><span className="repo-icon" aria-hidden>▤</span> <strong>{repo}</strong></div>
      <div className="muted small">
        {refs.data ? `${refs.data.length} ref${refs.data.length === 1 ? "" : "s"}` : "…"} · default ref <code>main</code>
      </div>
      {last && (
        <div className="small">
          Last change: {firstLine(last.meta.message)} — {authorName(last.meta.author)},{" "}
          {last.meta.authorTime ? relativeTime(last.meta.authorTime.seconds) : ""}
        </div>
      )}
    </Link>
  );
}

export function RepoRedirect() {
  const { repo } = useParams();
  return <Navigate to={urls.tree(repo ?? "", "main")} replace />;
}

export function NotFoundPage({ what = "Page" }: { what?: string }) {
  return (
    <Page title={`${what} not found`}>
      <p><Link to="/">Back to repositories</Link></p>
    </Page>
  );
}

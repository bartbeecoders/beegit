import { Link, useParams } from "react-router-dom";
import { useRefLog, useRefs } from "../api/queries";
import { RepoTabs } from "../components/Nav";
import { Avatar, Empty, ErrorBox, Id, Page, Spinner } from "../components/ui";
import { relativeTime } from "../lib/format";
import { urls } from "../lib/urls";

export function RefsPage() {
  const { repo = "" } = useParams();
  const refs = useRefs();
  return (
    <Page>
      <RepoTabs repo={repo} rev="main" active="refs" />
      {refs.isLoading && <Spinner />}
      {refs.error && <ErrorBox error={refs.error} />}
      {refs.data && (
        <table className="table card flush">
          <thead><tr><th>Ref</th><th>Tip</th><th>Version</th><th>Updated</th><th /></tr></thead>
          <tbody>
            {refs.data.map((r) => (
              <tr key={r.name}>
                <td><Link to={urls.tree(repo, r.name)}><strong>{r.name}</strong></Link></td>
                <td><Id id={r.target} to={urls.change(repo, r.target)} /></td>
                <td><Link to={urls.refLog(repo, r.name)}>v{r.version}</Link></td>
                <td className="muted" title={new Date(r.updatedAt).toLocaleString()}>{relativeTime(r.updatedAt / 1000)}</td>
                <td className="row-gap">
                  <Link className="btn btn-quiet" to={urls.log(repo, r.name)}>History</Link>
                  <Link className="btn btn-quiet" to={urls.compare(repo, "main", r.name)}>Compare</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Page>
  );
}

export function RefLogPage() {
  const { repo = "", name = "" } = useParams();
  const log = useRefLog(name);
  const entries = [...(log.data ?? [])].reverse();
  return (
    <Page title={<>Ref log of <code>{name}</code></>}>
      <RepoTabs repo={repo} rev={name} active="refs" />
      {log.isLoading && <Spinner />}
      {log.error && <ErrorBox error={log.error} />}
      {log.data && entries.length === 0 && <Empty>No history for this ref.</Empty>}
      <ul className="change-list card flush">
        {entries.map((e) => (
          <li className="change-row" key={e.version}>
            <Avatar principal={e.principal} size={28} />
            <div className="change-main">
              <div>
                <strong>v{e.version}</strong>{" "}
                {!e.oldTarget ? "created at" : !e.newTarget ? "deleted (was" : "moved"}{" "}
                {e.oldTarget && e.newTarget && <><Id id={e.oldTarget} to={urls.change(repo, e.oldTarget)} /> → </>}
                {e.newTarget ? <Id id={e.newTarget} to={urls.change(repo, e.newTarget)} /> : <Id id={e.oldTarget} />}
                {!e.newTarget && ")"}
                {e.landed.length > 0 && <span className="badge">landed {e.landed.length}</span>}
              </div>
              <div className="muted small">{e.principal} · <span title={new Date(e.at).toLocaleString()}>{relativeTime(e.at / 1000)}</span></div>
            </div>
            {e.oldTarget && e.newTarget && (
              <div className="change-side"><Link className="btn btn-quiet" to={urls.compare(repo, e.oldTarget, e.newTarget)}>Diff</Link></div>
            )}
          </li>
        ))}
      </ul>
    </Page>
  );
}

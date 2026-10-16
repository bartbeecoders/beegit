import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useChange, useDiff, useLog, type Change } from "../api/queries";
import { DiffView } from "../components/DiffView";
import { Breadcrumbs, RepoTabs } from "../components/Nav";
import { AuthorAvatar, Empty, ErrorBox, Id, Page, Spinner } from "../components/ui";
import { authorName, firstLine, formatTime, relativeTime } from "../lib/format";
import { urls } from "../lib/urls";
import { NotFoundPage } from "./Repos";
import { useRepoRoute } from "./route";

function ChangeRow({ repo, c }: { repo: string; c: Change }) {
  const [open, setOpen] = useState(false);
  const rest = c.meta.message.split("\n").slice(1).join("\n").trim();
  return (
    <li className="change-row">
      <AuthorAvatar author={c.meta.author} creator={c.meta.creator} size={28} />
      <div className="change-main">
        <div>
          <Link to={urls.change(repo, c.id)} className="change-title">
            {c.meta.redacted ? <em>redacted</em> : firstLine(c.meta.message) || <em>(no message)</em>}
          </Link>
          {rest && <button className="icon-btn" onClick={() => setOpen(!open)} aria-label="Show full message">…</button>}
          {c.parents.length > 1 && <span className="badge">merge</span>}
        </div>
        {open && <pre className="change-body">{rest}</pre>}
        <div className="muted small">
          <strong>{authorName(c.meta.author)}</strong>{" "}
          <span title={formatTime(c.meta.authorTime)}>{c.meta.authorTime ? relativeTime(c.meta.authorTime.seconds) : ""}</span>
          {c.meta.creator && c.meta.creator !== c.meta.author && <> · by {c.meta.creator}</>}
        </div>
      </div>
      <div className="change-side">
        <Id id={c.id} to={urls.change(repo, c.id)} />
        <Link className="btn btn-quiet" to={urls.tree(repo, c.id)} title="Browse the tree at this changeset">⌂</Link>
      </div>
    </li>
  );
}

export function LogPage() {
  const { repo, rev, path, cs, resolved, unknownRepo } = useRepoRoute();
  const [params, setParams] = useSearchParams();
  const firstParent = params.get("first-parent") === "1";
  const log = useLog(cs, path, firstParent);
  if (unknownRepo) return <NotFoundPage what="Repository" />;
  const entries = log.data?.pages.flatMap((p) => p.entries) ?? [];
  return (
    <Page>
      <RepoTabs repo={repo} rev={rev} active="log" />
      <div className="row-between">
        {path ? <Breadcrumbs repo={repo} rev={rev} path={path} leafIsFile /> : <h2 className="h2">History of <code>{rev}</code></h2>}
        <label className="check">
          <input type="checkbox" checked={firstParent}
            onChange={(e) => setParams(e.target.checked ? { "first-parent": "1" } : {})} /> First parent only
        </label>
      </div>
      {resolved.error && <ErrorBox error={resolved.error} title={`Unknown revision ${rev}`} />}
      {log.error && <ErrorBox error={log.error} />}
      {log.isLoading && <Spinner />}
      {log.data && entries.length === 0 && <Empty>No changesets touch {path ? <code>{path}</code> : "this revision"}.</Empty>}
      <ul className="change-list card flush">
        {entries.map((c) => <ChangeRow key={c.id} repo={repo} c={c} />)}
      </ul>
      {log.hasNextPage && (
        <button className="btn btn-wide" onClick={() => void log.fetchNextPage()} disabled={log.isFetchingNextPage}>
          {log.isFetchingNextPage ? "Loading…" : "Older changesets"}
        </button>
      )}
    </Page>
  );
}

export function ChangePage() {
  const { repo = "", id = "" } = useParams();
  const change = useChange(id);
  const parent = change.data?.parents[0];
  const diff = useDiff(parent, change.data ? id : undefined);
  const c = change.data;
  return (
    <Page>
      <RepoTabs repo={repo} rev={id} active="log" />
      {change.isLoading && <Spinner />}
      {change.error && <ErrorBox error={change.error} title="Changeset not found" />}
      {c && (
        <>
          <div className="card change-card">
            <h1 className="change-h">{c.meta.redacted ? <em>Metadata redacted</em> : firstLine(c.meta.message) || <em>(no message)</em>}</h1>
            {!c.meta.redacted && c.meta.message.includes("\n") && (
              <pre className="change-body">{c.meta.message.split("\n").slice(1).join("\n").trim()}</pre>
            )}
            <dl className="kv">
              <dt>Author</dt><dd><AuthorAvatar author={c.meta.author} creator={c.meta.creator} /> {c.meta.author} · {formatTime(c.meta.authorTime)}</dd>
              {c.meta.committer && <><dt>Committer</dt><dd>{c.meta.committer} · {formatTime(c.meta.committerTime)}</dd></>}
              <dt>Created by</dt><dd>{c.meta.creator}</dd>
              <dt>Changeset</dt><dd><Id id={c.id} /></dd>
              <dt>Change id</dt><dd><code>{c.changeId}</code></dd>
              <dt>Parents</dt>
              <dd>{c.parents.length ? c.parents.map((p) => <Id key={p} id={p} to={urls.change(repo, p)} />) : "none (root)"}</dd>
            </dl>
            <div className="row-gap">
              <Link className="btn" to={urls.tree(repo, c.id)}>Browse files</Link>
              {parent && <Link className="btn btn-quiet" to={urls.compare(repo, parent, c.id)}>Compare with parent</Link>}
            </div>
            {c.filtered && <div className="notice">Some changed paths are hidden because you cannot read them.</div>}
          </div>
          {diff.isLoading && <Spinner label="Loading diff…" />}
          {diff.error && <ErrorBox error={diff.error} />}
          {diff.data && (diff.data.length ? <DiffView diffs={diff.data} repo={repo} rev={c.id} /> : <Empty>No file changes.</Empty>)}
        </>
      )}
    </Page>
  );
}

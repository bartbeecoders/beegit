import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useFile, useLog, useTree, MODE, type TreeEntry } from "../api/queries";
import { fromUtf8 } from "../api/ids";
import { CodeView } from "../components/CodeView";
import { Markdown } from "../components/Markdown";
import { Breadcrumbs, RepoTabs } from "../components/Nav";
import { AuthorAvatar, Empty, ErrorBox, Id, Page, Spinner } from "../components/ui";
import { imageType, isBinary, isMarkdown, languageOf } from "../lib/content";
import { authorName, firstLine, formatBytes, relativeTime } from "../lib/format";
import { dirname, join, urls } from "../lib/urls";
import { NotFoundPage } from "./Repos";
import { useRepoRoute } from "./route";

const README = /^readme(\.(md|markdown|txt|rst))?$/i;
const DISPLAY_LIMIT = 2 * 1024 * 1024;

function sortEntries(es: TreeEntry[]) {
  return [...es].sort((a, b) =>
    (a.mode === MODE.tree ? 0 : 1) - (b.mode === MODE.tree ? 0 : 1) || a.name.localeCompare(b.name),
  );
}

function LastChange({ cs, path, repo }: { cs: string; path: string; repo: string }) {
  const log = useLog(cs, path, false);
  const e = log.data?.pages[0]?.entries[0];
  if (!e) return <div className="last-change muted">{log.isLoading ? "…" : ""}</div>;
  return (
    <div className="last-change">
      <AuthorAvatar author={e.meta.author} creator={e.meta.creator} />
      <strong>{authorName(e.meta.author)}</strong>
      <Link to={urls.change(repo, e.id)} className="truncate">{firstLine(e.meta.message)}</Link>
      <Id id={e.id} to={urls.change(repo, e.id)} />
      <span className="muted">{e.meta.authorTime ? relativeTime(e.meta.authorTime.seconds) : ""}</span>
      <Link to={urls.log(repo, cs, path)} className="btn btn-quiet">History</Link>
    </div>
  );
}

export function TreePage() {
  const { repo, rev, path, cs, resolved, unknownRepo } = useRepoRoute();
  const tree = useTree(cs, path);
  const navigate = useNavigate();
  if (unknownRepo) return <NotFoundPage what="Repository" />;
  const entries = tree.data ? sortEntries(tree.data) : [];
  const readme = entries.find((e) => e.mode !== MODE.tree && README.test(e.name));
  return (
    <Page>
      <RepoTabs repo={repo} rev={rev} active="code" />
      <Breadcrumbs repo={repo} rev={rev} path={path} />
      {resolved.error && <ErrorBox error={resolved.error} title={`Unknown revision ${rev}`} />}
      {tree.error && <ErrorBox error={tree.error} />}
      {(resolved.isLoading || tree.isLoading) && <Spinner />}
      {cs && tree.data && (
        <div className="card flush">
          <LastChange cs={cs} path={path} repo={repo} />
          {entries.length === 0 ? (
            <Empty>This directory is empty.</Empty>
          ) : (
            <table className="files">
              <tbody>
                {path && (
                  <tr className="file-row" onClick={() => navigate(urls.tree(repo, rev, dirname(path)))}>
                    <td className="ficon">↰</td>
                    <td colSpan={2}><Link to={urls.tree(repo, rev, dirname(path))}>..</Link></td>
                  </tr>
                )}
                {entries.map((e) => {
                  const p = join(path, e.name);
                  const to = e.mode === MODE.tree ? urls.tree(repo, rev, p) : urls.blob(repo, rev, p);
                  return (
                    <tr key={e.name} className="file-row" onClick={() => navigate(to)}>
                      <td className="ficon" aria-hidden>{e.mode === MODE.tree ? "📁" : e.mode === MODE.symlink ? "↪" : "📄"}</td>
                      <td><Link to={to} onClick={(ev) => ev.stopPropagation()}>{e.name}</Link></td>
                      <td className="fsize muted">{e.mode === MODE.tree ? "" : formatBytes(e.size)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
      {cs && readme && <Readme repo={repo} rev={rev} cs={cs} dir={path} entry={readme} />}
    </Page>
  );
}

function Readme({ repo, rev, cs, dir, entry }: { repo: string; rev: string; cs: string; dir: string; entry: TreeEntry }) {
  const file = useFile(cs, join(dir, entry.name), entry.size <= DISPLAY_LIMIT);
  if (!file.data) return null;
  const text = fromUtf8(file.data.data);
  return (
    <div className="card readme">
      <div className="card-head"><strong>{entry.name}</strong></div>
      {isMarkdown(entry.name) ? (
        <Markdown source={text} repo={repo} rev={rev} cs={cs} dir={dir} />
      ) : (
        <pre className="plain">{text}</pre>
      )}
    </div>
  );
}

export function BlobPage() {
  const { repo, rev, path, cs, resolved, unknownRepo } = useRepoRoute();
  const parent = useTree(cs, dirname(path));
  const name = path.split("/").pop() ?? "";
  const entry = parent.data?.find((e) => e.name === name);
  const tooLarge = !!entry && entry.size > DISPLAY_LIMIT;
  const file = useFile(cs, path, !!entry && entry.mode !== MODE.tree && !tooLarge);
  if (unknownRepo) return <NotFoundPage what="Repository" />;
  const data = file.data?.data;
  const download = () => {
    if (!data) return;
    const url = URL.createObjectURL(new Blob([data as BlobPart]));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <Page>
      <RepoTabs repo={repo} rev={rev} active="code" />
      <Breadcrumbs repo={repo} rev={rev} path={path} leafIsFile />
      {resolved.error && <ErrorBox error={resolved.error} title={`Unknown revision ${rev}`} />}
      {parent.error && <ErrorBox error={parent.error} />}
      {file.error && <ErrorBox error={file.error} />}
      {parent.data && !entry && <ErrorBox error={new Error(`${path} does not exist at ${rev}`)} title="Not found" />}
      {entry?.mode === MODE.tree && <ErrorBox error={new Error(`${path} is a directory`)} />}
      {cs && entry && entry.mode !== MODE.tree && (
        <div className="card flush">
          <LastChange cs={cs} path={path} repo={repo} />
          <div className="file-bar">
            <span className="muted">{formatBytes(entry.size)}{entry.mode === MODE.exec ? " · executable" : ""}{entry.mode === MODE.symlink ? " · symlink" : ""}</span>
            <span className="grow" />
            <Link className="btn btn-quiet" to={urls.blame(repo, rev, path)}>Blame</Link>
            <Link className="btn btn-quiet" to={urls.log(repo, rev, path)}>History</Link>
            {cs !== rev && <Link className="btn btn-quiet" to={urls.blob(repo, cs, path)} title="Link to this exact version">Permalink</Link>}
            <button className="btn btn-quiet" onClick={download} disabled={!data}>Download</button>
          </div>
          {tooLarge ? (
            <Empty>This file is {formatBytes(entry.size)} — too large to display. Use the CLI: <code>beegit cat {rev}:{path}</code></Empty>
          ) : file.error ? null : file.isLoading || !data ? (
            <Spinner />
          ) : imageType(path) ? (
            <ImageView data={data} type={imageType(path)!} alt={name} />
          ) : isBinary(data) ? (
            <Empty>Binary file ({formatBytes(data.length)}).</Empty>
          ) : isMarkdown(path) ? (
            <div className="readme"><Markdown source={fromUtf8(data)} repo={repo} rev={rev} cs={cs} dir={dirname(path)} /></div>
          ) : (
            <CodeView text={fromUtf8(data)} lang={languageOf(path)} />
          )}
        </div>
      )}
      {(resolved.isLoading || parent.isLoading) && <Spinner />}
    </Page>
  );
}

function ImageView({ data, type, alt }: { data: Uint8Array; type: string; alt: string }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    const u = URL.createObjectURL(new Blob([data as BlobPart], { type }));
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [data, type]);
  return <div className="image-view">{url && <img alt={alt} src={url} />}</div>;
}

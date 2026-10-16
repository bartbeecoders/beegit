import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { urls } from "../lib/urls";

/** repo / a / b / c breadcrumbs for a path at a revision. */
export function Breadcrumbs({ repo, rev, path, leafIsFile }: { repo: string; rev: string; path: string; leafIsFile?: boolean }) {
  const parts = path ? path.split("/") : [];
  return (
    <nav className="crumbs" aria-label="Path">
      <Link to={urls.tree(repo, rev)}>{repo}</Link>
      {parts.map((p, i) => {
        const sub = parts.slice(0, i + 1).join("/");
        const last = i === parts.length - 1;
        return (
          <span key={sub}>
            <span className="sep">/</span>
            {last ? <strong>{p}</strong> : <Link to={urls.tree(repo, rev, sub)}>{p}</Link>}
            {last && !leafIsFile ? <span className="sep">/</span> : null}
          </span>
        );
      })}
    </nav>
  );
}

/** Revision box: any revision the CLI accepts (main, release/1, main~3, c1ab…, git:<sha>). */
export function RevPicker({ rev, onPick }: { rev: string; onPick: (rev: string) => void }) {
  const [value, setValue] = useState(rev);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = value.trim();
    if (v) onPick(v);
  };
  return (
    <form className="rev-picker" onSubmit={submit} title="Ref name, main~3, ref@version, id prefix or git:<sha>">
      <span className="rev-icon" aria-hidden>⎇</span>
      <input value={value} onChange={(e) => setValue(e.target.value)} aria-label="Revision" spellCheck={false} />
    </form>
  );
}

/** Tabs for a repository section. */
export function RepoTabs({ repo, rev, active }: { repo: string; rev: string; active: "code" | "log" | "refs" | "compare" }) {
  const navigate = useNavigate();
  const tab = (key: typeof active, label: string, to: string) => (
    <Link className={`tab${active === key ? " on" : ""}`} to={to} aria-current={active === key ? "page" : undefined}>{label}</Link>
  );
  return (
    <div className="repo-bar">
      <div className="tabs">
        {tab("code", "Code", urls.tree(repo, rev))}
        {tab("log", "History", urls.log(repo, rev))}
        {tab("refs", "Refs", urls.refs(repo))}
        {tab("compare", "Compare", urls.compare(repo, rev, rev))}
      </div>
      <RevPicker key={rev} rev={rev} onPick={(r) => navigate(urls.tree(repo, r))} />
    </div>
  );
}

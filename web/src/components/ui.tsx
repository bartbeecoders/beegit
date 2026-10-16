import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { errorDetail, errorText, isCode, Code } from "../api/client";
import { shortId } from "../api/ids";

export function Spinner({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="spinner" role="status">
      <span className="spinner-dot" /> {label}
    </div>
  );
}

/** What a BeeGit error means for the viewer: redactions and missing access are expected
 * states, not failures, and get their own wording (SPEC 12.6, 13.4). */
function explain(error: unknown): { kind: string; title: string; text: string } | null {
  const code = errorDetail(error)?.code;
  if (code === "REDACTED")
    return { kind: "redacted", title: "Content redacted", text: "An administrator removed this content. Its id and history remain." };
  if (code === "PERMISSION_DENIED" || isCode(error, Code.PermissionDenied))
    return { kind: "denied", title: "No read access", text: "You do not have read access to this path. Ask an administrator if you need it." };
  if (code === "NOT_FOUND" || isCode(error, Code.NotFound))
    return { kind: "missing", title: "Not found", text: "It does not exist (at this revision)." };
  return null;
}

/** `title` names what failed ("Unknown revision main~9"); without it the state's own wording
 * is used. */
export function ErrorBox({ error, title }: { error: unknown; title?: string }) {
  const e = explain(error);
  if (e) {
    if (title) e.title = title;
    return (
      <div className={`state-box state-${e.kind}`} role="status">
        <span className="state-icon" aria-hidden>{e.kind === "redacted" ? "▒" : e.kind === "denied" ? "🔒" : "∅"}</span>
        <div>
          <strong>{e.title}</strong>
          <div className="muted">{e.text}</div>
          <code className="small muted">{errorText(error)}</code>
        </div>
      </div>
    );
  }
  return (
    <div className="error-box" role="alert">
      <strong>{title ?? "Something went wrong"}</strong>
      <code>{errorText(error)}</code>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

/** Short id that copies the full id on click. */
export function Id({ id, to }: { id: string; to?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(id).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <span className="id">
      {to ? <Link to={to}><code>{shortId(id)}</code></Link> : <code>{shortId(id)}</code>}
      <button className="icon-btn" title={`Copy ${id}`} onClick={copy} aria-label="Copy full id">
        {copied ? "✓" : "⧉"}
      </button>
    </span>
  );
}

/** github:<login> → avatar; services get an initial. */
export function Avatar({ principal, size = 20 }: { principal: string; size?: number }) {
  const gh = /^github:(.+)$/.exec(principal);
  if (gh) {
    return (
      <img className="avatar" src={`https://github.com/${encodeURIComponent(gh[1])}.png?size=${size * 2}`}
        width={size} height={size} alt="" loading="lazy" />
    );
  }
  const letter = (principal.split(":").pop() ?? "?").slice(0, 1).toUpperCase();
  return <span className="avatar avatar-letter" style={{ width: size, height: size }}>{letter}</span>;
}

/** The avatar for a changeset: the creator's GitHub picture when GitHub created it, else the
 * author's initial (imported history and service principals record the real author only in
 * the author field). */
export function AuthorAvatar({ author, creator, size = 20 }: { author: string; creator: string; size?: number }) {
  if (creator.startsWith("github:")) return <Avatar principal={creator} size={size} />;
  const name = author.replace(/\s*<[^>]*>\s*$/, "") || "?";
  return <Avatar principal={`author:${name}`} size={size} />;
}

export function Page({ title, actions, children }: { title?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <main className="page">
      {(title || actions) && (
        <div className="page-head">
          {title && <h1>{title}</h1>}
          {actions && <div className="page-actions">{actions}</div>}
        </div>
      )}
      {children}
    </main>
  );
}

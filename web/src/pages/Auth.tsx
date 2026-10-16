import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, errorText } from "../api/client";
import { setSession, useSession } from "../api/session";
import { useServerInfo, useWhoAmI } from "../api/queries";
import { Avatar, ErrorBox, Page, Spinner } from "../components/ui";

const STATE_KEY = "beegit.oauth";
const callbackUrl = () => `${window.location.origin}/auth/callback`;

function safeNext(next: string | null) {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

export function LoginPage() {
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));
  const info = useServerInfo();
  const session = useSession();
  const navigate = useNavigate();
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (session) navigate(next, { replace: true });
  }, [session, next, navigate]);

  const github = () => {
    const i = info.data!;
    const state = crypto.randomUUID();
    sessionStorage.setItem(STATE_KEY, JSON.stringify({ state, next }));
    const u = new URL(`${i.githubOauthBaseUrl.replace(/\/$/, "")}/login/oauth/authorize`);
    u.searchParams.set("client_id", i.githubClientId);
    u.searchParams.set("redirect_uri", callbackUrl());
    u.searchParams.set("state", state);
    u.searchParams.set("scope", "read:user");
    window.location.assign(u.toString());
  };

  const useToken = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const t = token.trim();
    // Check the token with an explicit header; it becomes the session only once accepted.
    try {
      const me = await api.auth.whoAmI({}, { headers: { authorization: `Bearer ${t}` } });
      setSession({ token: t, principal: me.principal, expiresAt: Number(me.expiresAtUnix) });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page title="Sign in to BeeGit">
      <div className="card narrow">
        {info.isLoading && <Spinner />}
        {info.error && <ErrorBox error={info.error} title="Cannot reach the BeeGit server" />}
        {info.data?.githubWebLogin ? (
          <button className="btn btn-primary btn-wide" onClick={github}>Sign in with GitHub</button>
        ) : info.data ? (
          <p className="muted">GitHub sign-in is not configured on this server (an OAuth App client secret is needed). Use a token instead.</p>
        ) : null}
        <details className="token-login" open={info.data ? !info.data.githubWebLogin : false}>
          <summary>Sign in with a BeeGit token</summary>
          <form onSubmit={useToken}>
            <p className="muted small">
              Run <code>beegit login</code>, then copy the <code>token</code> value from{" "}
              <code>~/.config/beegit/credentials</code>. It stays in this tab only.
            </p>
            <textarea value={token} onChange={(e) => setToken(e.target.value)} rows={3} spellCheck={false}
              aria-label="BeeGit token" placeholder="v4.public.…" />
            <button className="btn" disabled={!token.trim() || busy}>{busy ? "Checking…" : "Use token"}</button>
          </form>
          {error && <div className="error-inline">{error}</div>}
        </details>
      </div>
    </Page>
  );
}

export function AuthCallbackPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const once = useRef(false);
  useEffect(() => {
    if (once.current) return;
    once.current = true;
    const saved = JSON.parse(sessionStorage.getItem(STATE_KEY) ?? "null") as { state: string; next: string } | null;
    sessionStorage.removeItem(STATE_KEY);
    const code = params.get("code");
    if (params.get("error")) return setError(`GitHub: ${params.get("error_description") ?? params.get("error")}`);
    if (!code || !saved || saved.state !== params.get("state")) return setError("This sign-in link is invalid or expired. Start again.");
    api.auth
      .login({ credential: { case: "githubOauthCode", value: { code, redirectUri: callbackUrl() } } })
      .then((r) => {
        setSession({ token: r.token, principal: r.principal, expiresAt: Number(r.expiresAtUnix) });
        navigate(safeNext(saved.next), { replace: true });
      })
      .catch((e) => setError(errorText(e)));
  }, [params, navigate]);
  return (
    <Page title="Signing in…">
      {error ? (
        <div className="card narrow">
          <div className="error-inline">{error}</div>
          <Link className="btn" to="/login">Back to sign in</Link>
        </div>
      ) : (
        <Spinner label="Completing GitHub sign-in…" />
      )}
    </Page>
  );
}

export function AccountPage() {
  const me = useWhoAmI();
  return (
    <Page title="Account">
      {me.isLoading && <Spinner />}
      {me.error && <ErrorBox error={me.error} />}
      {me.data && (
        <div className="card narrow">
          <div className="account-head"><Avatar principal={me.data.principal} size={48} /> <strong>{me.data.principal}</strong></div>
          <dl className="kv">
            <dt>Groups</dt><dd>{me.data.groups.length ? me.data.groups.join(", ") : "—"}</dd>
            <dt>Session expires</dt><dd>{new Date(Number(me.data.expiresAtUnix) * 1000).toLocaleString()}</dd>
          </dl>
          <button className="btn" onClick={() => setSession(null)}>Sign out</button>
        </div>
      )}
    </Page>
  );
}

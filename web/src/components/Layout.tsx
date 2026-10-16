import { useEffect, useState, type ReactNode } from "react";
import { Link, Navigate, Outlet, useLocation } from "react-router-dom";
import { setSession, useSession } from "../api/session";
import { useServerInfo } from "../api/queries";
import { Avatar } from "./ui";

type Theme = "system" | "light" | "dark";

function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return (localStorage.getItem("beegit.theme") as Theme) || "system";
    } catch {
      return "system";
    }
  });
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
    try {
      localStorage.setItem("beegit.theme", theme);
    } catch {
      /* ignore */
    }
  }, [theme]);
  return [theme, setTheme];
}

export function Layout() {
  const session = useSession();
  const info = useServerInfo();
  const [theme, setTheme] = useTheme();
  const next: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };
  const icon: Record<Theme, string> = { system: "🌓", light: "☀️", dark: "🌙" };
  return (
    <div className="app">
      <header className="top">
        <Link to="/" className="brand"><span aria-hidden>🐝</span> BeeGit</Link>
        {info.data?.repo && session && (
          <Link className="top-repo" to={`/r/${encodeURIComponent(info.data.repo)}`}>{info.data.repo}</Link>
        )}
        <div className="top-right">
          <button className="icon-btn" onClick={() => setTheme(next[theme])} title={`Theme: ${theme}`} aria-label={`Theme: ${theme}`}>
            {icon[theme]}
          </button>
          {session ? (
            <span className="user">
              <Link to="/account" className="user-link"><Avatar principal={session.principal} /> <span className="user-name">{session.principal}</span></Link>
              <button className="btn btn-quiet" onClick={() => setSession(null)}>Sign out</button>
            </span>
          ) : (
            <Link className="btn" to="/login">Sign in</Link>
          )}
        </div>
      </header>
      <Outlet />
    </div>
  );
}

/** Pages that need a token: send the visitor to /login and back afterwards. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const session = useSession();
  const loc = useLocation();
  if (!session) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search + loc.hash)}`} replace />;
  return <>{children}</>;
}

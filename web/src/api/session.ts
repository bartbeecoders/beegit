// The browser session: a BeeGit token kept in memory and sessionStorage (never localStorage,
// so it ends with the tab). Components subscribe with useSession().
import { useSyncExternalStore } from "react";

export type Session = { token: string; principal: string; expiresAt: number };

const KEY = "beegit.session";
let current: Session | null = load();
const listeners = new Set<() => void>();

function load(): Session | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Session;
    return s.expiresAt * 1000 > Date.now() ? s : null;
  } catch {
    return null;
  }
}

function emit() {
  for (const l of listeners) l();
}

export function setSession(s: Session | null) {
  current = s;
  try {
    if (s) sessionStorage.setItem(KEY, JSON.stringify(s));
    else sessionStorage.removeItem(KEY);
  } catch {
    // private mode: keep it in memory only
  }
  emit();
}

export function getToken(): string | null {
  if (current && current.expiresAt * 1000 <= Date.now()) setSession(null);
  return current?.token ?? null;
}

export function useSession(): Session | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}

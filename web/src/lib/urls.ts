// Stable, shareable URLs. Revisions may contain "/" (release/1), so they are one encoded
// path segment; repository paths follow as the splat.
const seg = (s: string) => encodeURIComponent(s);
const rest = (p: string) => (p ? "/" + p.split("/").map(encodeURIComponent).join("/") : "");

export const urls = {
  repo: (repo: string) => `/r/${seg(repo)}`,
  tree: (repo: string, rev: string, path = "") => `/r/${seg(repo)}/tree/${seg(rev)}${rest(path)}`,
  blob: (repo: string, rev: string, path: string) => `/r/${seg(repo)}/blob/${seg(rev)}${rest(path)}`,
  blame: (repo: string, rev: string, path: string) => `/r/${seg(repo)}/blame/${seg(rev)}${rest(path)}`,
  log: (repo: string, rev: string, path = "") => `/r/${seg(repo)}/log/${seg(rev)}${rest(path)}`,
  change: (repo: string, id: string) => `/r/${seg(repo)}/c/${seg(id)}`,
  refs: (repo: string) => `/r/${seg(repo)}/refs`,
  refLog: (repo: string, name: string) => `/r/${seg(repo)}/refs/${seg(name)}`,
  compare: (repo: string, a = "", b = "") =>
    `/r/${seg(repo)}/compare${a || b ? `/${seg(a)}...${seg(b)}` : ""}`,
};

/** Parent directory of a repository path ("" for top-level entries). */
export const dirname = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
export const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

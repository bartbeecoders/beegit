// README / Markdown rendering: marked → DOMPurify (no scripts, no inline handlers).
// Relative links point into the repository browser; relative images are loaded through
// ReadPath (the API needs the bearer token, so plain <img src> cannot fetch them).
import DOMPurify from "dompurify";
import { marked } from "marked";
import { useEffect, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { idBytes, utf8 } from "../api/ids";
import { imageType } from "../lib/content";
import { join, urls } from "../lib/urls";

const external = (href: string) => /^[a-z][a-z0-9+.-]*:|^\/\/|^#/i.test(href);

function resolve(dir: string, href: string): string {
  const parts = (href.startsWith("/") ? href.slice(1) : join(dir, href)).split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return out.join("/");
}

export function Markdown(props: { source: string; repo: string; rev: string; cs: string; dir: string }) {
  const { source, repo, rev, cs, dir } = props;
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(source, { async: false, gfm: true }) as string),
    [source],
  );

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const urlsToRevoke: string[] = [];
    for (const a of Array.from(root.querySelectorAll("a[href]"))) {
      const href = a.getAttribute("href") ?? "";
      if (external(href)) {
        if (!href.startsWith("#")) {
          a.setAttribute("target", "_blank");
          a.setAttribute("rel", "noopener noreferrer");
        }
        continue;
      }
      const [pathPart, hash] = href.split("#");
      const target = resolve(dir, decodeURIComponent(pathPart));
      const to = (pathPart.endsWith("/") ? urls.tree(repo, rev, target) : urls.blob(repo, rev, target)) +
        (hash ? `#${hash}` : "");
      a.setAttribute("href", to);
      a.addEventListener("click", (e) => {
        e.preventDefault();
        navigate(to);
      });
    }
    for (const img of Array.from(root.querySelectorAll("img[src]"))) {
      const src = img.getAttribute("src") ?? "";
      if (external(src)) continue;
      const path = resolve(dir, decodeURIComponent(src));
      img.removeAttribute("src");
      void (async () => {
        const parts: Uint8Array[] = [];
        for await (const c of api.query.readPath({ changeset: idBytes(cs), path: utf8(path) })) parts.push(c.data);
        const url = URL.createObjectURL(new Blob(parts as BlobPart[], { type: imageType(path) ?? "application/octet-stream" }));
        urlsToRevoke.push(url);
        img.setAttribute("src", url);
      })().catch(() => img.setAttribute("alt", `${img.getAttribute("alt") ?? ""} (not found)`));
    }
    return () => urlsToRevoke.forEach((u) => URL.revokeObjectURL(u));
  }, [html, repo, rev, cs, dir, navigate]);

  return <div className="markdown" ref={ref} dangerouslySetInnerHTML={{ __html: html }} />;
}

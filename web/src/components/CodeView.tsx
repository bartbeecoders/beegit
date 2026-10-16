// A highlighted file with line numbers; #L12 / #L12-L20 anchors select and scroll.
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { highlightLines, plainLines } from "../lib/highlight";

export function useHighlighted(text: string, lang: string) {
  const plain = useMemo(() => plainLines(text), [text]);
  const [lines, setLines] = useState<string[]>(plain);
  useEffect(() => {
    let live = true;
    setLines(plain);
    void highlightLines(text, lang).then((l) => live && setLines(l));
    return () => {
      live = false;
    };
  }, [text, lang, plain]);
  return lines;
}

function selected(hash: string): [number, number] | null {
  const m = /^#L(\d+)(?:-L(\d+))?$/.exec(hash);
  if (!m) return null;
  const a = Number(m[1]);
  const b = m[2] ? Number(m[2]) : a;
  return [Math.min(a, b), Math.max(a, b)];
}

export function CodeView({ text, lang }: { text: string; lang: string }) {
  const lines = useHighlighted(text, lang);
  const { hash } = useLocation();
  const sel = selected(hash);
  useEffect(() => {
    if (sel) document.getElementById(`L${sel[0]}`)?.scrollIntoView({ block: "center" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hash, lines.length]);
  return (
    <div className="code" role="table">
      {lines.map((html, i) => {
        const n = i + 1;
        const on = sel && n >= sel[0] && n <= sel[1];
        return (
          <div key={n} id={`L${n}`} className={`code-line${on ? " sel" : ""}`} role="row">
            <a className="ln" href={`#L${n}`} aria-label={`Line ${n}`}>{n}</a>
            <span className="lc" dangerouslySetInnerHTML={{ __html: html || " " }} />
          </div>
        );
      })}
    </div>
  );
}

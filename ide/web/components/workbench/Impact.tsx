"use client";

import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { api, ApiError } from "@/lib/api";

interface ImpactReport {
  base: string;
  changedFiles: string[];
  interfaces: { file: string; symbol: string; change: string; before: string | null; after: string | null; line: number | null }[];
  consumers: { file: string; symbol: string; line: number; evidence: { kind: string; detail: string }; breaks: { prop: string; line: number; reason: string }[] }[];
  tests: { file: string; chain: string[] }[];
  tasks: { taskId: string; state: string; reasons: { kind: "static" | "declared"; detail: string }[] }[];
  stale: { taskId: string; kind: string; command: string | null; reason: string }[];
  suggestions: string[];
  gaps: string[];
  stats: { files: number; parsed: number; cached: number; ms: number };
}

/** The live dependency map for the shared workspace against HEAD. Every row says how it was established. */
export function ImpactPanel({ tick, onOpen, onTask }: { tick: number; onOpen: (path: string, line?: number) => void; onTask: (id: string) => void }) {
  const [r, setR] = useState<ImpactReport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => void api<ImpactReport>("GET", "/impact").then((x) => (setR(x), setErr(null)), (e) => setErr(e instanceof ApiError ? e.message : String(e))), 300);
    return () => clearTimeout(t);
  }, [tick, n]);

  if (err) return <p className="px-4 py-2 font-sans text-[13px] text-danger">{err}</p>;
  if (!r) return <p className="micro px-4 py-2 text-faint">Analysing imports</p>;
  const changed = r.interfaces.filter((i) => i.change !== "added");
  const Row = ({ tag, tone, children, onClick }: { tag: string; tone: string; children: React.ReactNode; onClick?: () => void }) => (
    <button onClick={onClick} disabled={!onClick} className="flex w-full items-baseline gap-3 px-4 py-[3px] text-left hover:bg-hover disabled:hover:bg-transparent">
      <span className={`micro w-[68px] shrink-0 ${tone}`}>{tag}</span>
      <span className="min-w-0 font-sans text-[12.5px] text-ink-2">{children}</span>
    </button>
  );
  return (
    <div data-testid="impact-panel">
      <div className="flex items-center gap-3 px-4 pb-1 pt-0.5 text-[11px] text-faint">
        <span>
          vs {r.base.slice(0, 7)} · {r.changedFiles.length} changed · {r.stats.files} modules · {r.stats.parsed} parsed, {r.stats.cached} cached · {r.stats.ms} ms
        </span>
        <button aria-label="Recompute impact" title="Recompute" onClick={() => setN((x) => x + 1)} className="grid size-5 place-items-center rounded-sm hover:bg-hover hover:text-ink">
          <RefreshCw size={11} />
        </button>
      </div>
      {changed.length === 0 && r.stale.length === 0 && <p className="px-4 py-1 font-sans text-[13px] text-muted">No exported interface differs from HEAD. Consumers, tests and tasks are unaffected.</p>}
      {changed.map((i) => (
        <Row key={`${i.file}#${i.symbol}`} tag="changed" tone="text-accent" onClick={() => onOpen(i.file, i.line ?? undefined)}>
          <span className="font-mono text-ink">{i.file}#{i.symbol}</span> <span className="text-faint">{i.change}</span>
          {i.before && (
            <span className="block font-mono text-[11.5px] text-muted">
              {i.before} <span className="text-faint">→</span> {i.after ?? "removed"}
            </span>
          )}
        </Row>
      ))}
      {r.consumers.map((c, k) => (
        <Row key={`c${k}`} tag={c.breaks.length ? "breaks" : "consumer"} tone={c.breaks.length ? "text-danger" : "text-muted"} onClick={() => onOpen(c.file, c.breaks[0]?.line ?? c.line)}>
          <span className="font-mono">{c.evidence.detail}</span>
          {c.breaks.map((b) => (
            <span key={b.line + b.prop} className="block text-danger">
              line {b.line}: {b.reason}
            </span>
          ))}
        </Row>
      ))}
      {r.tests.map((t) => (
        <Row key={t.file} tag="test" tone="text-ok" onClick={() => onOpen(t.file)}>
          <span className="font-mono">{t.chain.join(" → ")}</span>
        </Row>
      ))}
      {r.tasks.map((t) => (
        <Row key={t.taskId} tag="task" tone="text-ink-2" onClick={() => onTask(t.taskId)}>
          <span className="font-mono text-ink">{t.taskId}</span> <span className="text-faint">{t.state.replace("_", " ")}</span>
          {t.reasons.map((x, k) => (
            <span key={k} className="block text-[11.5px] text-muted">
              <span className="font-mono text-faint">{x.kind}</span> {x.detail}
            </span>
          ))}
        </Row>
      ))}
      {r.stale.map((s, k) => (
        <Row key={`s${k}`} tag="stale" tone="text-warn" onClick={() => onTask(s.taskId)}>
          {s.taskId} {s.kind.replace("_", " ")}
          {s.command ? <span className="font-mono"> “{s.command}”</span> : null}: {s.reason}
        </Row>
      ))}
      {r.suggestions.map((s, k) => (
        <Row key={`n${k}`} tag="next" tone="text-accent-ink">
          {s}
        </Row>
      ))}
      {r.gaps.map((g, k) => (
        <Row key={`g${k}`} tag="unseen" tone="text-faint">
          {g}
        </Row>
      ))}
    </div>
  );
}

"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronRight, CircleCheck, CircleX, CircleMinus, FileCode2, Play, RotateCcw, Square } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import type { TestRunView } from "@/lib/useProject";
import { ViewHeader } from "./Views";

type Discover = { runner: "node-test" | "npm-script" | null; command: string | null; testFiles: string[]; perTest: boolean; reason?: string };

/** Ask the server to run tests. Shared by the panel and the command palette. */
export async function runTests(body: { files?: string[]; names?: string[] }, notify: (m: string, t?: "ok" | "danger") => void) {
  try {
    await api("POST", "/tests/run", body);
  } catch (e) {
    notify(e instanceof ApiError ? e.message : String(e), "danger");
  }
}
export const stopTests = () => api("POST", "/tests/stop").catch(() => {});
export const failedNames = (run: TestRunView | null) => (run?.results ?? []).filter((r) => r.status === "fail").map((r) => r.name);
/** Rerun only the failed tests, in only the files they came from. */
export const rerunFailed = (run: TestRunView | null) => {
  const failed = (run?.results ?? []).filter((r) => r.status === "fail");
  return { names: failed.map((r) => r.name), files: [...new Set(failed.flatMap((r) => (r.file ? [r.file] : [])))] };
};

const ICON = { pass: <CircleCheck size={13} className="shrink-0 text-ok" />, fail: <CircleX size={13} className="shrink-0 text-danger" />, skip: <CircleMinus size={13} className="shrink-0 text-faint" />, todo: <CircleMinus size={13} className="shrink-0 text-faint" /> };

/**
 * The project's real tests: what runs, per-test results with source locations (Node's test runner), or the exit code and
 * output for other runners. Nothing is shown as passed unless the run reported it; results from an older revision say so.
 */
export function TestsPanel({ run, setRun, canRun, onOpen, notify }: { run: TestRunView | null; setRun: (r: TestRunView | null) => void; canRun: boolean; onOpen: (p: string, line?: number) => void; notify: (m: string, t?: "ok" | "danger") => void }) {
  const [disc, setDisc] = useState<Discover | null>(null);
  const [showOutput, setShowOutput] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());

  useEffect(() => {
    void api<{ discover: Discover; latest: TestRunView | null }>("GET", "/tests").then((r) => (setDisc(r.discover), r.latest && setRun(r.latest)), () => {});
  }, [setRun]);

  const groups = useMemo(() => {
    const m = new Map<string, TestRunView["results"]>();
    for (const r of run?.results ?? []) m.set(r.file ?? "(unknown file)", [...(m.get(r.file ?? "(unknown file)") ?? []), r]);
    return [...m.entries()].sort((a, b) => Number(b[1].some((r) => r.status === "fail")) - Number(a[1].some((r) => r.status === "fail")));
  }, [run]);
  const counts = { pass: 0, fail: 0, skip: 0, todo: 0 };
  for (const r of run?.results ?? []) counts[r.status]++;
  const running = run?.status === "running";
  const failed = failedNames(run);

  const btn = "flex h-[24px] items-center gap-1.5 rounded-sm px-2 text-[12px] text-ink-2 hover:bg-hover disabled:opacity-40 disabled:hover:bg-transparent";
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="tests-panel">
      <div className="flex shrink-0 items-center gap-1 px-3 py-1.5">
        {running ? (
          <button className={btn} onClick={() => void stopTests()} disabled={!canRun}>
            <Square size={12} /> Stop
          </button>
        ) : (
          <>
            <button className={btn} onClick={() => void runTests({}, notify)} disabled={!canRun || !disc?.runner} data-testid="tests-run-all">
              <Play size={12} /> Run all
            </button>
            <button className={btn} onClick={() => void runTests(rerunFailed(run), notify)} disabled={!canRun || !failed.length || run?.runner !== "node-test"} data-testid="tests-rerun-failed">
              <RotateCcw size={12} /> Rerun failed
            </button>
          </>
        )}
        <span className="ml-3 truncate font-mono text-[11px] text-faint">{run ? run.command : (disc?.command ?? "")}</span>
        {run && (
          <span className="ml-auto flex shrink-0 items-center gap-3 text-[12px]">
            {run.stale && !running && (
              <span className="text-warn" title="Files changed after this run. These results describe an earlier version." data-testid="tests-stale">
                Out of date
              </span>
            )}
            <span className="tnum text-muted" data-testid="tests-summary">
              {running ? "Running… " : `${run.status[0]!.toUpperCase()}${run.status.slice(1)} · `}
              {counts.pass} passed{counts.fail ? `, ${counts.fail} failed` : ""}
              {counts.skip + counts.todo ? `, ${counts.skip + counts.todo} skipped` : ""}
            </span>
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {!disc && <p className="px-4 py-2 text-[13px] text-muted">Looking for tests…</p>}
        {disc && !disc.runner && <p className="px-4 py-2 text-[13px] text-muted">{disc.reason}</p>}
        {disc?.runner && !run && <p className="px-4 py-2 text-[13px] text-muted">{disc.testFiles.length ? `${disc.testFiles.length} test files found. ` : ""}No run yet{canRun ? "; Run all starts one on this machine." : "; an owner can start one."}</p>}
        {run && !disc?.perTest && run.runner === "npm-script" && <p className="px-4 pb-1 text-[12px] text-faint">This project's test command isn't Node's test runner, so results are its exit code ({run.exitCode ?? "—"}) and output only.</p>}
        {groups.map(([file, rs]) => (
          <div key={file}>
            <div className="flex items-center gap-2 px-4 pt-1.5 font-mono text-[11.5px] text-muted">
              {file}
              <span className="tnum text-faint">{rs.filter((r) => r.status === "fail").length ? `${rs.filter((r) => r.status === "fail").length} failed` : ""}</span>
            </div>
            {rs.map((r, i) => {
              const key = `${file}:${i}`;
              return (
                <div key={key}>
                  <button
                    onClick={() => (r.error ? setOpen((s) => new Set(s.has(key) ? [...s].filter((k) => k !== key) : [...s, key])) : r.file && onOpen(r.file, r.line ?? undefined))}
                    className="flex w-full items-center gap-2 px-4 py-[3px] text-left text-[13px] hover:bg-hover"
                    data-testid={`test-${r.status}`}
                  >
                    {r.error ? <ChevronRight size={12} className={`shrink-0 text-faint transition-transform ${open.has(key) ? "rotate-90" : ""}`} /> : <span className="w-3 shrink-0" />}
                    {ICON[r.status]}
                    <span className="truncate text-ink-2">{r.name}</span>
                    {r.durationMs !== null && <span className="tnum ml-auto shrink-0 font-mono text-[11px] text-faint">{Math.round(r.durationMs)} ms</span>}
                  </button>
                  {open.has(key) && r.error && (
                    <div className="ml-12 mr-4 mb-1">
                      {r.file && (
                        <button onClick={() => onOpen(r.file!, r.line ?? undefined)} className="font-mono text-[11.5px] text-accent-ink hover:underline">
                          {r.file}:{r.line}
                        </button>
                      )}
                      <pre className="mt-0.5 max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[11.5px] text-danger">{r.error}</pre>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
        {run && (
          <div className="px-4 pt-2">
            <button onClick={() => setShowOutput((v) => !v)} className="flex items-center gap-1 text-[12px] text-muted hover:text-ink">
              <ChevronRight size={12} className={showOutput ? "rotate-90" : ""} /> Raw output
            </button>
            {showOutput && <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap font-mono text-[11.5px] text-ink-2">{run.output.split("\n").filter((l) => !l.startsWith('{"relay":1')).join("\n") || "(no output)"}</pre>}
            <p className="mt-1 font-mono text-[10.5px] text-faint">
              revision {run.revision.slice(0, 10)} · started by {run.startedBy} {new Date(run.startedAt).toLocaleTimeString([], { hour12: false })}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The Testing view (activity bar), as VS Code has it: every test file the project's runner finds, each with the tests
 * the latest run reported. Run everything, one file, or the failures; click a test to open it. Files the latest run
 * didn't cover say "not run", never "passed".
 */
export function TestingView({ run, setRun, canRun, onOpen, notify }: { run: TestRunView | null; setRun: (r: TestRunView | null) => void; canRun: boolean; onOpen: (p: string, line?: number) => void; notify: (m: string, t?: "ok" | "danger") => void }) {
  const [disc, setDisc] = useState<Discover | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  useEffect(() => {
    void api<{ discover: Discover; latest: TestRunView | null }>("GET", "/tests").then((r) => (setDisc(r.discover), r.latest && setRun(r.latest)), () => {});
  }, [setRun]);
  const byFile = useMemo(() => {
    const m = new Map<string, TestRunView["results"]>();
    for (const f of disc?.testFiles ?? []) m.set(f, []);
    for (const r of run?.results ?? []) if (r.file) m.set(r.file, [...(m.get(r.file) ?? []), r]);
    return [...m.entries()].filter(([f, rs]) => !filter || f.toLowerCase().includes(filter.toLowerCase()) || rs.some((r) => r.name.toLowerCase().includes(filter.toLowerCase())));
  }, [disc, run, filter]);
  const running = run?.status === "running";
  const failed = failedNames(run);
  const perFile = disc?.runner === "node-test";
  const why = !canRun ? "Only project owners can run tests (they run on the Relay host)" : !disc?.runner ? (disc?.reason ?? "No test runner found in this project") : running ? "Tests are already running" : null;
  const iconBtn = "grid size-6 place-items-center rounded-sm text-muted hover:bg-hover hover:text-ink disabled:text-faint disabled:hover:bg-transparent";
  const fileStatus = (rs: TestRunView["results"]) => (!rs.length ? null : rs.some((r) => r.status === "fail") ? "fail" : rs.every((r) => r.status !== "pass") ? "skip" : "pass");
  return (
    <div className="flex h-full flex-col" data-testid="testing-view">
      <ViewHeader
        title="Testing"
        actions={
          <>
            {running ? (
              <button aria-label="Stop tests" title={canRun ? "Stop" : (why ?? "")} disabled={!canRun} onClick={() => void stopTests()} className={iconBtn}>
                <Square size={13} />
              </button>
            ) : (
              <button aria-label="Run all tests" title={why ?? "Run All Tests"} disabled={!!why} onClick={() => void runTests({}, notify)} className={iconBtn} data-testid="testing-run-all">
                <Play size={13} />
              </button>
            )}
            <button aria-label="Rerun failed tests" title={why ?? (!failed.length ? "No failed tests in the latest run" : !perFile ? "Rerunning single tests needs Node's test runner" : "Rerun Failed Tests")} disabled={!!why || !failed.length || !perFile} onClick={() => void runTests(rerunFailed(run), notify)} className={iconBtn}>
              <RotateCcw size={13} />
            </button>
          </>
        }
      />
      <div className="px-3 pb-2">
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter tests" aria-label="Filter tests" className="h-[26px] w-full rounded-sm border border-rule bg-editor px-2 text-[13px] outline-none focus:border-accent" />
        <p className="mt-1.5 text-[11.5px] text-muted">
          {!disc ? "Finding tests…" : !disc.runner ? (disc.reason ?? "No test runner found") : run ? `${run.results.filter((r) => r.status === "pass").length} passed, ${failed.length} failed${run.stale ? " · out of date" : ""}${running ? " · running…" : ""}` : `${disc.testFiles.length} test files · not run yet`}
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {byFile.map(([file, rs]) => {
          const st = fileStatus(rs);
          const isOpen = open.has(file) || (!!filter && rs.length > 0);
          return (
            <div key={file}>
              <div className="group flex h-6 items-center pr-1 hover:bg-hover">
                <button onClick={() => setOpen((s) => (s.has(file) ? (s.delete(file), new Set(s)) : new Set(s).add(file)))} className="flex min-w-0 flex-1 items-center gap-1.5 pl-2 text-left text-[13px]" data-testid={`testing-file-${file}`}>
                  <ChevronRight size={13} className={`shrink-0 text-faint transition-transform ${isOpen ? "rotate-90" : ""}`} />
                  {st ? ICON[st] : <CircleMinus size={13} className="shrink-0 text-faint" aria-label="not run" />}
                  <span className="truncate text-ink-2">{file.split("/").pop()}</span>
                  <span className="truncate text-[11px] text-faint">{file.split("/").slice(0, -1).join("/")}</span>
                </button>
                <button aria-label={`Run tests in ${file}`} title={why ?? (perFile ? `Run ${file}` : "Running one file needs Node's test runner")} disabled={!!why || !perFile} onClick={() => void runTests({ files: [file] }, notify)} className={`${iconBtn} hidden group-hover:grid`}>
                  <Play size={12} />
                </button>
                <button aria-label={`Open ${file}`} title="Open file" onClick={() => onOpen(file)} className={`${iconBtn} hidden group-hover:grid`}>
                  <FileCode2 size={12} />
                </button>
              </div>
              {isOpen &&
                (rs.length ? (
                  rs.map((r, i) => (
                    <button key={`${r.name}:${i}`} onClick={() => onOpen(file, r.line ?? undefined)} title={r.error ?? undefined} className="flex h-6 w-full items-center gap-1.5 pl-9 pr-2 text-left text-[12.5px] hover:bg-hover">
                      {ICON[r.status]}
                      <span className={`truncate ${r.status === "fail" ? "text-danger" : "text-ink-2"}`}>{r.name}</span>
                      {r.durationMs !== null && <span className="tnum ml-auto shrink-0 text-[11px] text-faint">{Math.round(r.durationMs)} ms</span>}
                    </button>
                  ))
                ) : (
                  <p className="py-1 pl-9 text-[12px] text-faint">Not run yet</p>
                ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

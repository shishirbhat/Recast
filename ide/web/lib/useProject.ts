"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";
import type { ProjectState, RelayEvent } from "./types";

/** Live presence from the server (ephemeral): who is online, which file they're in, when they last acted. */
export interface Presence {
  online: string[];
  participants: { memberId: string; path: string; at: number; typedAt: number | null; typing: boolean }[];
}

/** The latest test run (or the one in progress), as the server reports it. */
export interface TestRunView {
  id: string;
  command: string;
  runner: "node-test" | "npm-script";
  files: string[];
  revision: string;
  status: "running" | "passed" | "failed" | "stopped" | "error";
  exitCode: number | null;
  startedAt: string;
  endedAt: string | null;
  startedBy: string;
  results: { name: string; file: string | null; line: number | null; status: "pass" | "fail" | "skip" | "todo"; durationMs: number | null; error: string | null }[];
  output: string;
  stale: boolean;
}

export type Load = { kind: "loading" } | { kind: "signed-out" } | { kind: "error"; message: string } | { kind: "ready"; state: ProjectState };

/**
 * Project state from the server, refreshed when the engine records events (pushed over /events)
 * and every few seconds for presence. The server is the source of truth; nothing here is optimistic.
 */
export function useProject() {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [events, setEvents] = useState<RelayEvent[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  const [live, setLive] = useState(false);
  const [presence, setPresence] = useState<Presence>({ online: [], participants: [] });
  const [testRun, setTestRun] = useState<TestRunView | null>(null);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const state = await api<ProjectState>("GET", "/state");
      setLoad({ kind: "ready", state });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setLoad({ kind: "signed-out" });
      else setLoad((l) => (l.kind === "ready" ? l : { kind: "error", message: e instanceof Error ? e.message : String(e) }));
    }
  }, []);

  const refreshFiles = useCallback(async () => {
    try {
      const r = await api<{ files: string[]; folders?: string[] }>("GET", "/files");
      setFiles(r.files);
      setFolders(r.folders ?? []);
    } catch {}
  }, []);

  const soon = useCallback(() => {
    if (pending.current) return;
    pending.current = setTimeout(() => {
      pending.current = null;
      void refresh();
    }, 120);
  }, [refresh]);

  useEffect(() => {
    void refresh();
    void refreshFiles();
    const poll = setInterval(() => void refresh(), 4000);
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    let lastSeq = 0;
    const connect = () => {
      // After a drop, resume from the last event seen so nothing that happened meanwhile is missed.
      ws = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/events${lastSeq ? `?since=${lastSeq}` : ""}`);
      ws.onopen = () => setLive(true);
      ws.onmessage = (m) => {
        const msg = JSON.parse(String(m.data)) as { type: string; events: RelayEvent[]; run?: TestRunView } & Presence;
        // The newest event when this connection opened: where to resume from after a drop.
        if (msg.type === "hello") return void (lastSeq = Math.max(lastSeq, (msg as unknown as { seq: number }).seq));
        if (msg.type === "tests") return setTestRun(msg.run ?? null);
        if (msg.type === "presence") return setPresence({ online: msg.online, participants: msg.participants });
        if (msg.type !== "events") return;
        const fresh = msg.events.filter((e) => e.seq > lastSeq);
        if (!fresh.length) return;
        lastSeq = fresh.at(-1)!.seq;
        setEvents((prev) => [...prev, ...fresh].slice(-400));
        if (fresh.some((e) => ["file.created", "file.renamed", "file.deleted", "folder.created"].includes(e.type))) void refreshFiles();
        soon();
      };
      ws.onclose = () => {
        setLive(false);
        if (!closed) retry = setTimeout(connect, 1500);
      };
    };
    connect();
    return () => {
      closed = true;
      clearInterval(poll);
      if (retry) clearTimeout(retry);
      ws?.close();
    };
  }, [refresh, refreshFiles, soon]);

  return { load, events, files, folders, live, presence, testRun, setTestRun, refresh, refreshFiles };
}

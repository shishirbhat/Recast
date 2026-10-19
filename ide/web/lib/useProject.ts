"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";
import type { ProjectState, RelayEvent } from "./types";

export type Load = { kind: "loading" } | { kind: "signed-out" } | { kind: "error"; message: string } | { kind: "ready"; state: ProjectState };

/**
 * Project state from the server, refreshed when the engine records events (pushed over /events)
 * and every few seconds for presence. The server is the source of truth; nothing here is optimistic.
 */
export function useProject() {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [events, setEvents] = useState<RelayEvent[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  const [live, setLive] = useState(false);
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
      setFiles((await api<{ files: string[] }>("GET", "/files")).files);
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
    const connect = () => {
      ws = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/events`);
      ws.onopen = () => setLive(true);
      ws.onmessage = (m) => {
        const msg = JSON.parse(String(m.data)) as { type: string; events: RelayEvent[] };
        if (msg.type !== "events") return;
        setEvents((prev) => [...prev, ...msg.events].slice(-400));
        if (msg.events.some((e) => e.type === "file.created")) void refreshFiles();
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

  return { load, events, files, live, refresh, refreshFiles };
}

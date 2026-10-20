import type { WebsocketProvider } from "y-websocket";

/**
 * On disconnect, y-websocket drops other people's presence but keeps their awareness clocks. When the server resends
 * an unchanged state on reconnect it carries the same clock, so it's ignored, and carets only reappear at the next
 * renewal (up to ~15 s). Forgetting remote clocks on disconnect makes the server's resend apply immediately.
 */
export function restorePresenceOnReconnect(provider: WebsocketProvider): void {
  const awareness = provider.awareness;
  provider.on("status", ({ status }: { status: string }) => {
    if (status !== "disconnected") return;
    for (const id of [...awareness.meta.keys()]) if (id !== awareness.clientID && !awareness.states.has(id)) awareness.meta.delete(id);
  });
}

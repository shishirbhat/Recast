import type { Page, WebSocketRoute } from "playwright-core";

/**
 * A network partition for one browser's document connections: while cut, messages in both directions are dropped
 * (as on a dead network, the client isn't told); `heal` then drops the connections so the client reconnects for real.
 */
export interface Partition {
  cut(): void;
  heal(): Promise<void>;
}
export async function partitionable(p: Page, what: RegExp = /\/collab\//): Promise<Partition> {
  let cut = false;
  const links: { page: WebSocketRoute; server: WebSocketRoute }[] = [];
  await p.routeWebSocket(what, (ws) => {
    const srv = ws.connectToServer();
    ws.onMessage((m) => void (!cut && srv.send(m)));
    srv.onMessage((m) => void (!cut && ws.send(m)));
    srv.onClose((code, reason) => void ws.close({ code, reason }));
    links.push({ page: ws, server: srv });
  });
  return {
    cut: () => void (cut = true),
    heal: async () => {
      cut = false;
      for (const l of links.splice(0)) {
        await l.server.close().catch(() => {});
        await l.page.close({ code: 1012, reason: "network restored" }).catch(() => {});
      }
    },
  };
}


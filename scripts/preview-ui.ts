/**
 * Renders sample screens in Relay's terminal look so the design can be reviewed before every
 * command adopts it. SAMPLE DATA ONLY: nothing here reads a Relay database.
 *
 *   node scripts/preview-ui.ts [status|why|integrate|error|all]
 *   NO_COLOR=1 node scripts/preview-ui.ts status    # plain fallback
 */
import { PALETTE, Painter, card, detectColorMode, mark, pill, statePill, t, wrap } from "../src/ui/theme.ts";
import type { Line, Seg } from "../src/ui/theme.ts";

const p = new Painter(detectColorMode(), 76);
const gap = () => console.log("");
const prompt = (cmd: string) => console.log(p.paint([{ text: "$ ", fg: PALETTE.soft }, { text: cmd, fg: p.color ? "#d8d8c8" : undefined }]));

const header: Seg[] = [...mark(p), t.ink(" relay", true), t.soft("  ·  "), t.muted("demo-shop"), t.soft("  ·  "), t.muted("main @ 4f2a1c9")];

function status(): void {
  prompt("relay status");
  const row = (id: string, state: string, who: string, what: string, note?: Seg[]): Line => [
    t.ink(id.padEnd(8), true),
    ...statePill(p, state, 11),
    t.soft("  "),
    t.muted(who.padEnd(13)),
    t.ink(what),
    ...(note ?? []),
  ];
  const body: Line[] = [
    [t.ink("Good afternoon. ", true), t.muted("2 tasks moving, 1 waiting on you.")],
    [],
    [t.soft("TASKS")],
    row("T-api", "running", "claude-code", "Server side of user-api"),
    row("T-ui", "review_required", "claude-code", "Greeting UI"),
    row("T-docs", "blocked", "—", "README update", [t.soft("  waits on T-ui")]),
    [],
    [t.soft("CONTRACTS")],
    [t.fathom("user-api".padEnd(10), true), ...pill(p, "v2 accepted", "calm"), t.soft("  v1 superseded 12 min ago")],
    [t.soft("".padEnd(10)), t.wine("T-api is still on v1 ", true), t.muted("(stale since 14:09)")],
    [],
    [t.soft("NEEDS YOU")],
    [t.glow("→ "), t.ink("T-ui is review-ready but can't be approved alone.")],
    [t.ink("  "), t.muted("It shares user-api with T-api. "), t.code(" relay why T-ui ")],
  ];
  console.log(card(p, body, { title: header, footer: [t.soft("relay help · relay status --json")] }));
}

function why(): void {
  prompt("relay why T-ui");
  const check = (ok: boolean | null, text: Seg[], detail?: string): Line[] => [
    [ok === null ? t.soft("·  ") : ok ? { text: "✓  ", fg: PALETTE.successInk, bold: true } : { text: "✕  ", fg: PALETTE.wine, bold: true }, ...text],
    ...(detail ? wrap(detail, 66, { fg: PALETTE.muted }, "   ") : []),
  ];
  const body: Line[] = [
    [t.ink("T-ui ", true), t.muted("Greeting UI  "), ...statePill(p, "review_required")],
    [],
    [t.soft("HOW FAR IT GOT")],
    [t.muted("agent says done   "), ...pill(p, "claimed", "neutral", "◦"), t.soft("  claude-code · 14:21 · not proof")],
    [t.muted("Relay verified    "), ...pill(p, "verified", "good", "✓"), t.soft("  on tree 9c1e04b, the current one")],
    [t.muted("you approved      "), ...pill(p, "not yet", "attention", "◆"), t.soft("  blocked, see below")],
    [],
    [t.soft("WHAT RELAY CHECKED")],
    ...check(true, [t.ink("Diff check: "), t.muted("1 file changed, all inside T-ui's scope")]),
    ...check(true, [t.ink("Verification: "), t.code(" node --check src/ui.js "), t.muted(" passed")]),
    ...check(false, [t.wine("Contract partner unfinished", true)], "T-ui and T-api both depend on user-api. T-api is still working against v1, so approving T-ui alone could ship a client that the server cannot answer."),
    [],
    [t.soft("NEXT")],
    [t.glow("1 "), t.muted("Let T-api adapt to v2:   "), t.code(" relay task show T-api ")],
    [t.glow("2 "), t.muted("Then check them together: "), t.code(" relay integrate check T-ui,T-api ")],
  ];
  console.log(card(p, body, { title: [t.ink("Why can't this be approved?", true)], footer: [t.soft("exit 3 · blocked")] }));
}

function integrate(): void {
  prompt("relay integrate check T-ui,T-api --verify \"npm test\"");
  const body: Line[] = [
    [...pill(p, "ready to approve", "good", "✓"), t.muted("  2 tasks · user-api v2 · tree 7b3d9a0")],
    [],
    [t.soft("RAN BY RELAY ON THIS EXACT TREE")],
    [{ text: "✓  ", fg: PALETTE.successInk, bold: true }, t.code(" node --check src/ui.js "), t.soft("        0.1s")],
    [{ text: "✓  ", fg: PALETTE.successInk, bold: true }, t.code(" node --check src/server.js "), t.soft("    0.1s")],
    [{ text: "✓  ", fg: PALETTE.successInk, bold: true }, t.code(" npm test "), t.soft("                      1.8s  14 passed")],
    [],
    [t.soft("WHAT CHANGED")],
    [t.ink("src/server.js  "), t.soft("T-api   "), { text: "+1 −1", fg: PALETTE.fathom }],
    [t.ink("src/ui.js      "), t.soft("T-ui    "), { text: "+1 −1", fg: PALETTE.fathom }],
    [],
    [t.muted("Approving completes both tasks together. If anything changes first,")],
    [t.muted("Relay asks you to check again.")],
    [],
    [...pill(p, "relay integrate approve 3f9c", "action", "→")],
  ];
  console.log(card(p, body, { title: [t.ink("Integration check", true)], footer: [t.soft("exit 0")] }));
}

function error(): void {
  prompt("relay task complete T-ui");
  const body: Line[] = [
    [{ text: "■ ", fg: PALETTE.wine, bold: true }, t.wine("Not approved. Nothing was changed.", true)],
    [],
    ...wrap("T-ui shares the user-api contract with T-api, which hasn't finished. Relay only approves tasks that share a contract together, after testing them as one change.", 70, { fg: PALETTE.ink }),
    [],
    [t.soft("TRY")],
    [t.code(" relay why T-ui "), t.muted("   see everything that's missing")],
    [t.code(" relay integrate check T-ui,T-api ")],
  ];
  console.log(card(p, body, { title: [t.ink("Can't complete T-ui", true)], footer: [t.soft("exit 3")], paper: "#fff8f2" }));
}

const screens: Record<string, () => void> = { status, why, integrate, error };
const which = process.argv[2] ?? "all";
for (const [name, fn] of Object.entries(screens)) {
  if (which === "all" || which === name) {
    fn();
    gap();
  }
}

// The clay layer: objects drawn as soft blobs that fuse when pressed together. Framework-free DOM, so the same renderer runs
// in the harness, in a browser extension's content script and in the try-it page.
//
// How the fusion is drawn (real, not a video): every blob is a rounded shape inside one SVG group with a "goo" filter
// (gaussian blur, then a steep alpha threshold). Shapes whose blurred edges overlap become one continuous outline, so as the
// incoming blob travels into the target the seam closes the way two drops of liquid join. Labels sit on top in HTML
// (the filter would blur text). Motion is springs stepped every frame. With reduced motion there is no travel and no goo
// stretch: the incoming blob disappears and the target gives one short outline pulse.

export interface ClayItem {
  id: string; x: number; y: number;
  label: string; detail?: string;
  /** How many pieces it is made of: 1 is a fragment, more is a composition. */
  count: number;
  kind: "person" | "place" | "time" | "text" | "title" | "thing" | "page" | "error" | "event" | "message" | "people" | "note" | "issue" | "phone" | "code";
  mode: "rest" | "carried" | "accepts" | "refuses";
  proposed?: boolean;
  focused?: boolean;
  /** Drawn smaller, for a tight space (beside the destination wheel). Same object, same label. */
  compact?: boolean;
}

/** Same numbers as design/tokens.css (--spring-carry-*). */
const SPRING = { k: 300, c: 24, m: 0.8 };
const GLYPH: Record<ClayItem["kind"], string> = { person: "●", place: "◆", time: "◷", text: "❝", title: "T", thing: "▣", page: "▤", error: "⚠", event: "▦", message: "✉", people: "●●", note: "❞", issue: "⚑", phone: "☏", code: "⌗" };

interface Body { id: string; el: HTMLElement; shape: SVGRectElement; x: number; y: number; vx: number; vy: number; w: number; h: number; s: number; vs: number; tx: number; ty: number; ts: number; gone?: boolean }

export interface Clay {
  update(items: ClayItem[]): void;
  /** Play the fusion of `incomingId` into `targetId`. Resolves when it has settled. */
  fuse(targetId: string, incomingId: string): Promise<void>;
  label(id: string): HTMLElement | undefined;
  /** Centre and size of an object as drawn now (for hit-testing). */
  box(id: string): { x: number; y: number; w: number; h: number } | undefined;
  destroy(): void;
}

let uid = 0;
export function createClay(host: HTMLElement, opts: { reducedMotion?: () => boolean; onPointerDown?: (id: string, e: PointerEvent) => void; onActivate?: (id: string) => void } = {}): Clay {
  const reduced = opts.reducedMotion ?? (() => matchMedia("(prefers-reduced-motion: reduce)").matches);
  const fid = `clay-goo-${++uid}`;
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg"); svg.setAttribute("class", "clay-svg"); svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = `<defs><filter id="${fid}" x="-30%" y="-60%" width="160%" height="220%" color-interpolation-filters="sRGB">
    <feGaussianBlur in="SourceGraphic" stdDeviation="9" result="b"/>
    <feColorMatrix in="b" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 26 -11" result="g"/>
    <feComposite in="SourceGraphic" in2="g" operator="atop"/></filter></defs>`;
  const group = document.createElementNS(NS, "g"); group.setAttribute("filter", `url(#${fid})`); svg.appendChild(group);
  const labels = document.createElement("div"); labels.className = "clay-labels";
  host.classList.add("clay-host"); host.append(svg, labels);

  const bodies = new Map<string, Body>();
  let raf = 0; let last = performance.now();

  function ensure(it: ClayItem): Body {
    let b = bodies.get(it.id);
    if (!b) {
      const shape = document.createElementNS(NS, "rect"); group.appendChild(shape);
      const el = document.createElement("div"); el.className = "clay-item"; el.dataset["id"] = it.id; el.tabIndex = -1;
      el.addEventListener("pointerdown", (e) => opts.onPointerDown?.(it.id, e));
      el.addEventListener("click", (e) => { if ((e as PointerEvent).detail === 0) return; });
      labels.appendChild(el);
      b = { id: it.id, el, shape, x: it.x, y: it.y, vx: 0, vy: 0, w: 120, h: 44, s: reduced() ? 1 : 0.6, vs: 0, tx: it.x, ty: it.y, ts: 1 };
      bodies.set(it.id, b);
    }
    return b;
  }

  function update(items: ClayItem[]) {
    const seen = new Set<string>();
    for (const it of items) {
      seen.add(it.id); const b = ensure(it); b.gone = false;
      b.tx = it.x; b.ty = it.y;
      b.ts = it.mode === "carried" ? 1.06 : it.mode === "accepts" ? 1.1 : 1;
      const el = b.el;
      el.className = `clay-item mode-${it.mode}${it.count > 1 ? " composed" : ""}${it.proposed ? " proposed" : ""}${it.focused ? " focused" : ""}${it.compact ? " compact" : ""}`;
      el.dataset["kind"] = it.kind; el.dataset["count"] = String(it.count);
      const text = `<span class="clay-glyph" aria-hidden="true">${GLYPH[it.kind]}</span><span class="clay-text"><span class="clay-label">${esc(it.label)}</span>${it.detail ? `<span class="clay-detail">${esc(it.detail)}</span>` : ""}</span>${it.count > 1 ? `<span class="clay-count" aria-hidden="true">${it.count}</span>` : ""}${it.mode === "refuses" ? `<span class="clay-no">won't combine</span>` : ""}`;
      if (el.dataset["html"] !== text) { el.innerHTML = text; el.dataset["html"] = text; }
      el.setAttribute("aria-label", `${it.label}${it.detail ? `, ${it.detail}` : ""}${it.count > 1 ? `, made of ${it.count} pieces` : ""}`);
      b.shape.setAttribute("class", `clay-shape kind-${it.kind}${it.count > 1 ? " composed" : ""} mode-${it.mode}`);
    }
    for (const [id, b] of bodies) if (!seen.has(id) && !b.gone) remove(id);
    // Measure after layout so the blob hugs its label.
    for (const it of items) { const b = bodies.get(it.id)!; b.w = Math.max(64, b.el.offsetWidth); b.h = Math.max(40, b.el.offsetHeight); }
    kick();
  }

  function remove(id: string) { const b = bodies.get(id); if (!b) return; b.shape.remove(); b.el.remove(); bodies.delete(id); }

  function step(dt: number) {
    let moving = false;
    for (const b of bodies.values()) {
      if (reduced()) { b.x = b.tx; b.y = b.ty; b.s = b.ts; b.vx = b.vy = b.vs = 0; }
      else {
        for (const [p, v, t] of [["x", "vx", "tx"], ["y", "vy", "ty"], ["s", "vs", "ts"]] as const) {
          const f = -SPRING.k * (b[p] - b[t]) - SPRING.c * b[v];
          b[v] += (f / SPRING.m) * dt; b[p] += b[v] * dt;
          if (Math.abs(b[p] - b[t]) > 0.05 || Math.abs(b[v]) > 0.05) moving = true; else { b[p] = b[t]; b[v] = 0; }
        }
      }
      const w = b.w * b.s, h = b.h * b.s;
      b.shape.setAttribute("x", String(b.x - w / 2)); b.shape.setAttribute("y", String(b.y - h / 2));
      b.shape.setAttribute("width", String(w)); b.shape.setAttribute("height", String(h)); b.shape.setAttribute("rx", String(h / 2));
      b.el.style.transform = `translate(${b.x - b.w / 2}px, ${b.y - b.h / 2}px) scale(${b.s})`;
    }
    return moving;
  }
  function frame(t: number) { const dt = Math.min(0.032, (t - last) / 1000); last = t; raf = step(dt) ? requestAnimationFrame(frame) : 0; }
  function kick() { if (!raf) { last = performance.now(); step(0); raf = requestAnimationFrame(frame); } }

  async function fuse(targetId: string, incomingId: string) {
    const t = bodies.get(targetId), inc = bodies.get(incomingId);
    if (!t) return;
    if (!inc || reduced()) {
      if (inc) remove(incomingId);
      t.el.classList.add("fused"); setTimeout(() => t.el.classList.remove("fused"), 220);
      return;
    }
    // Pressed in: the incoming blob travels into the target's centre and shrinks as it is absorbed; the goo filter joins the
    // outlines as they overlap; the target swells to take it, then settles back to its size.
    inc.gone = true; inc.tx = t.x; inc.ty = t.y; inc.ts = 0.35; t.ts = 1.14; inc.el.style.opacity = "0";
    t.el.classList.add("fusing"); kick();
    await wait(260);
    remove(incomingId); t.ts = 1; t.el.classList.remove("fusing"); t.el.classList.add("fused"); kick();
    await wait(260); t.el.classList.remove("fused");
  }

  return {
    update, fuse,
    label: (id) => bodies.get(id)?.el,
    box: (id) => { const b = bodies.get(id); return b ? { x: b.x, y: b.y, w: b.w, h: b.h } : undefined; },
    destroy: () => { cancelAnimationFrame(raf); svg.remove(); labels.remove(); bodies.clear(); },
  };
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Styles for the layer. Colours come from design/tokens.css custom properties, with fallbacks so it also works on its own. */
export const CLAY_CSS = `
.clay-host { position: fixed; inset: 0; pointer-events: none; z-index: 2147483000; }
.clay-svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.clay-shape { fill: var(--clay-fill, #fff7f2); stroke: none; }
.clay-shape.composed { fill: var(--clay-fill-composed, #ffe5dc); }
.clay-shape.mode-carried { fill: var(--clay-fill-carried, #fff); }
.clay-labels { position: absolute; inset: 0; }
.clay-item { position: absolute; left: 0; top: 0; transform-origin: center; display: inline-flex; align-items: center; gap: 8px; padding: 10px 16px; max-width: 280px;
  border-radius: 999px; color: var(--clay-ink, #1a1a1a); font: 500 14px/1.25 var(--font-ui, system-ui, sans-serif); pointer-events: auto; cursor: grab; user-select: none; -webkit-user-select: none; touch-action: none;
  box-shadow: inset 0 1px 0 rgba(255,255,255,.55), inset 0 -4px 10px rgba(120,60,20,.07), 0 1px 0 rgba(0,0,0,.04), 0 6px 18px rgba(26,26,26,.10); background: transparent; outline: none; }
.clay-item.mode-carried { cursor: grabbing; box-shadow: 0 14px 34px rgba(26,26,26,.22); }
.clay-item.composed { padding: 12px 18px; }
.clay-item.compact { padding: 8px 12px; font-size: 13px; max-width: 214px; }
.clay-item.compact.proposed .clay-label::after { content: none; }
.clay-item .clay-glyph { color: var(--clay-accent, #b83d12); font-size: 13px; }
.clay-item .clay-text { display: flex; flex-direction: column; min-width: 0; }
.clay-item .clay-label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.clay-item.proposed .clay-label::after { content: " ·  proposed"; color: var(--clay-muted, #6b6b6b); font-weight: 400; font-size: 12px; }
.clay-item .clay-detail { font-size: 12px; font-weight: 400; color: var(--clay-muted, #6b6b6b); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.clay-item .clay-count { margin-left: 2px; min-width: 20px; height: 20px; border-radius: 999px; display: inline-grid; place-items: center; font-size: 11px; font-weight: 600; background: var(--clay-accent, #b83d12); color: #fff; }
.clay-item.mode-accepts { box-shadow: 0 0 0 2px var(--clay-accent, #b83d12), 0 10px 26px rgba(184,61,18,.22); }
.clay-item.mode-refuses { box-shadow: 0 0 0 2px var(--clay-muted, #6b6b6b); outline: 2px dashed var(--clay-muted, #6b6b6b); outline-offset: 4px; }
.clay-item .clay-no { font-size: 11px; color: var(--clay-muted, #6b6b6b); margin-left: 4px; }
.clay-item.focused, .clay-item:focus-visible { box-shadow: 0 0 0 3px var(--clay-focus, #1a1a1a), 0 6px 18px rgba(26,26,26,.10); }
.clay-item.fused { animation: clay-fused 220ms ease-out; }
@keyframes clay-fused { from { box-shadow: 0 0 0 6px var(--clay-accent, #b83d12); } to { box-shadow: 0 1px 0 rgba(0,0,0,.04), 0 6px 18px rgba(26,26,26,.10); } }
@media (prefers-color-scheme: dark) { .clay-shape { fill: var(--clay-fill, #2b2420); } .clay-shape.composed { fill: var(--clay-fill-composed, #3d1f14); } .clay-shape.mode-carried { fill: var(--clay-fill-carried, #33302d); } .clay-item { color: var(--clay-ink, #f3f1ec); } .clay-item .clay-detail, .clay-item.proposed .clay-label::after { color: var(--clay-muted, #b5b0a8); } .clay-item .clay-glyph { color: var(--clay-accent, #ff8a5c); } }
`;

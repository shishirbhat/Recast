/**
 * Relay's terminal look: warm paper cards, ink text, pastel pills.
 * Palette after Wispr Flow's light, editorial style (cream paper, near-black ink, lavender action,
 * glow orange, wine for trouble, fathom green). Cards paint their own background so they read
 * the same on light and dark terminals. Without color support everything degrades to plain text
 * with the same layout.
 */

export const PALETTE = {
  paper: "#ffffeb",
  paperDeep: "#efefd9",
  paperEdge: "#e4e4d0",
  white: "#ffffff",
  ink: "#1a1a1a",
  muted: "#66665c",
  soft: "#8c8c80",
  hairline: "#c9c9b4",
  lavender: "#f0d7ff",
  lavenderInk: "#5b2a86",
  glow: "#ffa946",
  glowSoft: "#ffe7c7",
  wine: "#7f1c34",
  wineSoft: "#f8e4e4",
  fathom: "#034f46",
  fathomSoft: "#d6ebe4",
  successInk: "#114e0b",
  successSoft: "#cef5ca",
  warnInk: "#5e5515",
  warnSoft: "#fcf3c4",
} as const;

export type ColorMode = "truecolor" | "ansi256" | "none";

export interface Style {
  fg?: string;
  bg?: string;
  bold?: boolean;
  italic?: boolean;
}

export interface Seg extends Style {
  text: string;
}

export function detectColorMode(stream: NodeJS.WriteStream = process.stdout, env = process.env): ColorMode {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return "none";
  if (env.RELAY_COLOR === "never") return "none";
  const forced = env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "0";
  if (!forced && env.RELAY_COLOR !== "always" && !stream.isTTY) return "none";
  if (env.TERM === "dumb") return "none";
  if (/truecolor|24bit/i.test(env.COLORTERM ?? "") || env.RELAY_COLOR === "always" || env.FORCE_COLOR === "3") return "truecolor";
  return "ansi256";
}

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Nearest xterm-256 color: the 6x6x6 cube or the grey ramp, whichever is closer. */
function to256(hex: string): number {
  const [r, g, b] = rgb(hex);
  const q = (v: number) => (v < 48 ? 0 : v < 115 ? 1 : Math.floor((v - 35) / 40));
  const levels = [0, 95, 135, 175, 215, 255];
  const [cr, cg, cb] = [q(r), q(g), q(b)];
  const cube = 16 + 36 * cr + 6 * cg + cb;
  const cubeDist = (levels[cr]! - r) ** 2 + (levels[cg]! - g) ** 2 + (levels[cb]! - b) ** 2;
  const grey = Math.max(0, Math.min(23, Math.round(((r + g + b) / 3 - 8) / 10)));
  const gv = 8 + grey * 10;
  const greyDist = (gv - r) ** 2 + (gv - g) ** 2 + (gv - b) ** 2;
  return greyDist < cubeDist ? 232 + grey : cube;
}

export class Painter {
  readonly mode: ColorMode;
  readonly width: number;

  constructor(mode: ColorMode, width = 76) {
    this.mode = mode;
    this.width = width;
  }

  get color(): boolean {
    return this.mode !== "none";
  }

  private sgr(s: Style): string {
    if (!this.color) return "";
    const codes: string[] = ["0"];
    if (s.bold) codes.push("1");
    if (s.italic) codes.push("3");
    if (s.fg) codes.push(this.mode === "truecolor" ? `38;2;${rgb(s.fg).join(";")}` : `38;5;${to256(s.fg)}`);
    if (s.bg) codes.push(this.mode === "truecolor" ? `48;2;${rgb(s.bg).join(";")}` : `48;5;${to256(s.bg)}`);
    return `\x1b[${codes.join(";")}m`;
  }

  paint(segs: Seg[]): string {
    const reset = this.color ? "\x1b[0m" : "";
    return segs.map((s) => this.sgr(s) + s.text).join("") + reset;
  }
}

export const visibleLength = (segs: Seg[]) => segs.reduce((n, s) => n + [...s.text].length, 0);

// ---------- building blocks ----------

export type Line = Seg[];

const STATE_PILL: Record<string, { label: string; fg: string; bg: string; mark: string }> = {
  proposed: { label: "proposed", fg: PALETTE.muted, bg: PALETTE.paperEdge, mark: "◦" },
  queued: { label: "queued", fg: PALETTE.ink, bg: PALETTE.white, mark: "◦" },
  running: { label: "working", fg: PALETTE.lavenderInk, bg: PALETTE.lavender, mark: "●" },
  blocked: { label: "blocked", fg: PALETTE.wine, bg: PALETTE.wineSoft, mark: "■" },
  review_required: { label: "in review", fg: PALETTE.warnInk, bg: PALETTE.warnSoft, mark: "◆" },
  failed: { label: "failed", fg: PALETTE.wine, bg: PALETTE.wineSoft, mark: "✕" },
  completed: { label: "approved", fg: PALETTE.successInk, bg: PALETTE.successSoft, mark: "✓" },
  cancelled: { label: "cancelled", fg: PALETTE.soft, bg: PALETTE.paperEdge, mark: "–" },
};

export type Tone = "neutral" | "action" | "attention" | "trouble" | "good" | "calm";
const TONE: Record<Tone, { fg: string; bg: string }> = {
  neutral: { fg: PALETTE.ink, bg: PALETTE.white },
  action: { fg: PALETTE.lavenderInk, bg: PALETTE.lavender },
  attention: { fg: "#6b3a00", bg: PALETTE.glowSoft },
  trouble: { fg: PALETTE.wine, bg: PALETTE.wineSoft },
  good: { fg: PALETTE.successInk, bg: PALETTE.successSoft },
  calm: { fg: PALETTE.fathom, bg: PALETTE.fathomSoft },
};

/** A pill: padded label on a soft tint. Plain mode keeps it legible as [label]. */
export function pill(p: Painter, label: string, tone: Tone, mark?: string): Seg[] {
  const t = TONE[tone];
  const text = `${mark ? mark + " " : ""}${label}`;
  return p.color ? [{ text: ` ${text} `, fg: t.fg, bg: t.bg, bold: true }] : [{ text: `[${text}]` }];
}

export function statePill(p: Painter, state: string, width = 0): Seg[] {
  const s = STATE_PILL[state] ?? { label: state, fg: PALETTE.ink, bg: PALETTE.white, mark: "·" };
  const text = `${s.mark} ${s.label}`;
  if (!p.color) return [{ text: `[${text}]`.padEnd(width ? width + 2 : 0) }];
  return [{ text: ` ${text} `.padEnd(width ? width + 2 : 0), fg: s.fg, bg: s.bg, bold: true }];
}

/** Relay's mark: a small waveform, a nod to a voice-first tool, in glow orange. */
export function mark(p: Painter): Seg[] {
  return p.color ? [{ text: "▁▃▆█▆▃▁", fg: PALETTE.glow }] : [{ text: "~relay~" }];
}

export const t = {
  ink: (text: string, bold = false): Seg => ({ text, fg: PALETTE.ink, bold }),
  muted: (text: string): Seg => ({ text, fg: PALETTE.muted }),
  soft: (text: string): Seg => ({ text, fg: PALETTE.soft }),
  fathom: (text: string, bold = false): Seg => ({ text, fg: PALETTE.fathom, bold }),
  wine: (text: string, bold = false): Seg => ({ text, fg: PALETTE.wine, bold }),
  lavender: (text: string, bold = false): Seg => ({ text, fg: PALETTE.lavenderInk, bold }),
  glow: (text: string): Seg => ({ text, fg: "#b35f00", bold: true }),
  code: (text: string): Seg => ({ text, fg: PALETTE.lavenderInk, bg: PALETTE.paperDeep }),
};

/**
 * A paper card: rounded hairline border, cream background painted edge to edge.
 * `title` sits in the top border; `footer` in the bottom one.
 */
export function card(p: Painter, body: Line[], opts: { title?: Seg[]; footer?: Seg[]; paper?: string } = {}): string {
  const W = p.width;
  const paper = opts.paper ?? PALETTE.paper;
  const edge: Style = { fg: PALETTE.hairline, bg: paper };
  const withBg = (segs: Seg[]): Seg[] => segs.map((s) => ({ ...s, bg: s.bg ?? paper, fg: s.fg ?? PALETTE.ink }));
  const out: string[] = [];

  const rule = (left: string, right: string, label?: Seg[]): string => {
    const lab = label ? [{ text: " " }, ...label, { text: " " }] : [];
    const fill = Math.max(0, W - 2 - 2 - visibleLength(lab));
    return p.paint([{ text: left + "─", ...edge }, ...withBg(lab), { text: "─".repeat(fill) + "─" + right, ...edge }]);
  };

  out.push(rule("╭", "╮", opts.title));
  for (const line of [[], ...body, []]) {
    const content = withBg(line);
    const pad = Math.max(0, W - 4 - visibleLength(content));
    out.push(p.paint([{ text: "│ ", ...edge }, ...content, { text: " ".repeat(pad), bg: paper }, { text: " │", ...edge }]));
  }
  out.push(rule("╰", "╯", opts.footer));
  return out.join("\n");
}

/** Wrap plain text into lines of at most `width` characters, prefixing each with `indent`. */
export function wrap(text: string, width: number, style: Style = {}, indent = ""): Line[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: Line[] = [];
  let cur = "";
  for (const w of words) {
    if ((indent + cur + (cur ? " " : "") + w).length > width && cur) {
      lines.push([{ text: indent + cur, ...style }]);
      cur = w;
    } else cur += (cur ? " " : "") + w;
  }
  if (cur) lines.push([{ text: indent + cur, ...style }]);
  return lines;
}

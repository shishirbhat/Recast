/** Shared styles for the API app's pages: tokens with a dark mode. Interim; the final look comes with the UI pass (docs/design-direction.md). */
export const CSS = `
:root { --bg:#f7f7f5; --panel:#ffffff; --ink:#1c1d21; --muted:#5d6068; --line:#dcdcd6; --accent:#9a3412; --code:#f1f1ec; }
@media (prefers-color-scheme: dark) { :root { --bg:#141518; --panel:#1c1d21; --ink:#ececea; --muted:#a3a5ab; --line:#33353b; --accent:#fb923c; --code:#232429; } }
body { background: var(--bg); color: var(--ink); }
a { color: var(--accent); }
pre:focus-visible, .tablewrap:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.docs { max-width: 860px; margin: 0 auto; padding: 48px 16px 96px; line-height: 1.55; }
.docs h1 { font-size: 34px; margin: 0 0 4px; } .docs h2 { font-size: 22px; margin: 40px 0 8px; } .docs h3 { font-size: 16px; margin: 24px 0 6px; }
.docs p, .docs li { color: var(--ink); } .docs .muted { color: var(--muted); }
.docs a { color: var(--accent); }
.docs pre { background: var(--code); border: 1px solid var(--line); border-radius: 10px; padding: 14px; overflow-x: auto; font-size: 13px; line-height: 1.45; }
.docs code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.92em; }
.docs nav ul { display: flex; flex-wrap: wrap; gap: 6px 16px; padding: 0; list-style: none; }
.docs table { width: 100%; border-collapse: collapse; font-size: 14px; } .docs th, .docs td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
.docs .tablewrap { overflow-x: auto; }
.docs .pill { display: inline-block; font-size: 12px; border: 1px solid var(--line); border-radius: 999px; padding: 0 8px; color: var(--muted); }

.docs .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; }
.docs .card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; }
.docs .card h3 { margin: 0 0 6px; } .docs .card p { margin: 0; font-size: 14px; }
.docs .evidence { margin-top: 8px; font-size: 12px; color: var(--muted); word-break: break-word; }
.docs .lead { font-size: 19px; } .docs .hero { font-size: 38px; line-height: 1.15; margin: 0 0 10px; }
.docs .cta { display: inline-block; background: var(--accent); color: var(--panel); text-decoration: none; padding: 10px 16px; border-radius: 10px; font-weight: 600; }
`;

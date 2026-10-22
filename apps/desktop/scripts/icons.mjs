// Renders the app and tray icons from one drawing (run once; the PNGs are committed): a warm capsule with its ember mark.
import { chromium } from "playwright-core";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../build"); mkdirSync(out, { recursive: true });
const app = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2a2522"/><stop offset="1" stop-color="#141311"/></linearGradient>
  <linearGradient id="cap" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fffaf6"/><stop offset="1" stop-color="#f1e6dc"/></linearGradient>
  <radialGradient id="dot" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="#ffb48f"/><stop offset=".7" stop-color="#ff6b35"/><stop offset="1" stop-color="#c2410c"/></radialGradient></defs>
  <rect x="64" y="64" width="896" height="896" rx="200" fill="url(#bg)"/>
  <rect x="190" y="402" width="644" height="220" rx="110" fill="url(#cap)"/>
  <rect x="190" y="402" width="644" height="220" rx="110" fill="none" stroke="#ffffff" stroke-opacity=".5" stroke-width="4"/>
  <circle cx="300" cy="512" r="58" fill="url(#dot)"/><circle cx="300" cy="512" r="82" fill="none" stroke="#ff6b35" stroke-opacity=".25" stroke-width="14"/>
  <rect x="410" y="490" width="300" height="44" rx="22" fill="#1a1a1a" fill-opacity=".14"/></svg>`;
const tray = (color) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 22 22"><rect x="2" y="7" width="18" height="8" rx="4" fill="none" stroke="${color}" stroke-width="1.6"/><circle cx="6.5" cy="11" r="2" fill="${color}"/></svg>`;
const exe = process.env.RECAST_CHROMIUM ?? (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
const b = await chromium.launch(exe ? { executablePath: exe } : {});
async function render(svg, size, file) {
  const p = await b.newPage({ viewport: { width: size, height: size } });
  await p.setContent(`<html><body style="margin:0;background:transparent">${svg.replace("<svg ", `<svg width="${size}" height="${size}" `)}</body></html>`);
  writeFileSync(path.join(out, file), await p.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } }));
  await p.close();
}
await render(app, 1024, "icon.png");
await render(tray("#f3f1ec"), 32, "tray.png"); await render(tray("#f3f1ec"), 64, "tray@2x.png");
await render(tray("#000000"), 22, "trayTemplate.png"); await render(tray("#000000"), 44, "trayTemplate@2x.png");
await b.close(); console.log("icons rendered");

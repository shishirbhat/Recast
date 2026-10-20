// Builds the clay page twice from one source: dist/clay.html for the harness (local fonts, no network) and
// dist/clay-artifact.html for the try-it page (fonts from Google Fonts, no document skeleton: the publisher adds it).
import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "dist"); mkdirSync(out, { recursive: true });
const js = (await build({ entryPoints: [path.join(root, "src/clay.ts")], bundle: true, write: false, format: "iife", target: "es2020", platform: "browser", minify: true, legalComments: "none", logLevel: "warning" })).outputFiles[0].text;
const css = readFileSync(path.join(root, "src/clay.css"), "utf8");
const page = readFileSync(path.join(root, "src/clay.html"), "utf8").replace("/*@CSS*/", () => css).replace("/*@JS*/", () => js.replace(/<\/script/gi, "<\\/script"));
const google = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap">`;
writeFileSync(path.join(out, "clay-artifact.html"), page.replace("<!--@FONTS-->", google));
writeFileSync(path.join(out, "clay.html"), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><link rel="icon" href="data:,"><link rel="stylesheet" href="fonts.css">\n${page.replace("<!--@FONTS-->", "").replace(/<div class="app">/, "</head><body><div class=\"app\">")}</body></html>`);
console.log(`clay built (${Math.round(js.length / 1024)} KB of script)`);

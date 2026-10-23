// Reading the screen, so Recast can highlight what a person is likely to pick up (spots.ts) in whatever app is in front.
// The display is captured once (Electron's desktopCapturer) and read by OCR (tesseract.js) here, on this computer: the
// image and the words never leave it, are never stored, and are dropped as soon as the spots are found. The English
// model ships with the app (no download). On a Mac this needs the Screen Recording permission, which macOS asks for once;
// without it the highlights are simply absent and selecting by hand still works.
import { desktopCapturer, systemPreferences, type Display, type NativeImage } from "electron";
import path from "node:path";
import type { Line } from "./spots.js";

type Tess = typeof import("tesseract.js");
type TWorker = Awaited<ReturnType<Tess["createWorker"]>>;
let worker: Promise<TWorker> | null = null;
/** Files the OCR reads at run time live outside the app archive (asarUnpack), where a worker thread can open them. */
const unpacked = (p: string) => p.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);

function ocr(): Promise<TWorker> {
  worker ??= (async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const T = require("tesseract.js") as Tess;
    const langPath = unpacked(path.dirname(require.resolve("@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz")));
    return within(30_000, "the text reader did not start", T.createWorker("eng", 1, { langPath, gzip: true, cacheMethod: "none", ...(__filename.includes("app.asar") ? { workerPath: unpacked(require.resolve("tesseract.js/src/worker-script/node/index.js")) } : {}) }));
  })();
  return worker;
}

/** A step that must not hang Recast: it fails with a reason after `ms` instead. */
function within<T>(ms: number, why: string, p: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => { const t = setTimeout(() => reject(new Error(why)), ms); p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); }); });
}

/** On a Mac, whether Recast may see the screen ("granted"), has not been asked yet, or was refused. */
export const screenAccess = () => (process.platform === "darwin" ? systemPreferences.getMediaAccessStatus("screen") : "granted");

/** The display as an image, at its real resolution (capped, for speed), before Recast draws anything on it. */
export async function capture(display: Display): Promise<{ image: NativeImage; scale: number } | null> {
  const sf = display.scaleFactor || 1;
  const w = Math.round(display.size.width * sf), h = Math.round(display.size.height * sf);
  const k = Math.min(1, 2560 / w);
  const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: Math.round(w * k), height: Math.round(h * k) } }).catch(() => []);
  const src = sources.find((s) => s.display_id === String(display.id)) ?? (sources.length === 1 ? sources[0] : undefined);
  if (!src || src.thumbnail.isEmpty()) return null;
  return { image: src.thumbnail, scale: src.thumbnail.getSize().width / display.size.width };
}

/** The words on the image, by line, in the display's own coordinates (what the overlay draws in). */
export async function read(shot: { image: NativeImage; scale: number }): Promise<Line[]> {
  const w = await ocr().catch((e) => { worker = null; throw e; });   // a reader that failed to start is tried again next time
  const { data } = await within(30_000, "reading the screen took too long", w.recognize(shot.image.toPNG(), {}, { blocks: true }));
  const lines: Line[] = [];
  for (const b of data.blocks ?? []) for (const p of b.paragraphs) for (const l of p.lines) {
    const words = l.words.filter((x) => x.confidence >= 25 && x.text.trim())
      .map((x) => ({ text: x.text, x0: x.bbox.x0 / shot.scale, y0: x.bbox.y0 / shot.scale, x1: x.bbox.x1 / shot.scale, y1: x.bbox.y1 / shot.scale }));
    if (words.length) lines.push({ words, box: { x0: l.bbox.x0 / shot.scale, y0: l.bbox.y0 / shot.scale, x1: l.bbox.x1 / shot.scale, y1: l.bbox.y1 / shot.scale } });
  }
  return lines;
}

export async function stopReading() { if (worker) { const w = await worker.catch(() => null); worker = null; await w?.terminate().catch(() => {}); } }

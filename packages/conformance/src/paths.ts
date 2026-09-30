import { fileURLToPath } from "node:url";
import path from "node:path";
const here = path.dirname(fileURLToPath(import.meta.url));
export const PKG = path.resolve(here, "..");
export const CORE_DIST = path.resolve(PKG, "../core/dist");
export const OUT = path.resolve(PKG, "dist");
export const GOLDEN = path.resolve(PKG, "golden");

// Runs the end-to-end tests against the built Electron app. On Linux without a screen, a virtual one (Xvfb) with a real
// window manager (Openbox) and compositor when they are installed, as on a desktop: it is what keeps Recast's overlay above other windows,
// so the tests see the stacking a person sees (without one, "always on top" means nothing and clicks would pass for the
// wrong reason).
import { spawnSync } from "node:child_process";
const needsX = process.platform === "linux" && !process.env.DISPLAY;
const has = (cmd) => process.platform === "linux" && spawnSync("sh", ["-c", `command -v ${cmd}`]).status === 0;
// A compositor too (xcompmgr), as every desktop has: without one nothing can be see-through and screenshots would lie.
const inner = `${has("xcompmgr") ? "xcompmgr >/dev/null 2>&1 & " : ""}${has("openbox") ? "openbox >/dev/null 2>&1 & sleep 1; " : ""}npx vitest run`;
const r = needsX ? spawnSync("xvfb-run", ["-a", "-s", "-screen 0 1440x900x24", "sh", "-c", inner], { stdio: "inherit" })
  : process.platform === "linux" ? spawnSync("sh", ["-c", inner], { stdio: "inherit" })
  : spawnSync("npx", ["vitest", "run"], { stdio: "inherit", shell: process.platform === "win32" });
process.exit(r.status ?? 1);

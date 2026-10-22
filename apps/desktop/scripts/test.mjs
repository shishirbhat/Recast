// Runs the end-to-end tests against the built Electron app. On Linux without a screen, a virtual one (Xvfb).
import { spawnSync } from "node:child_process";
const needsX = process.platform === "linux" && !process.env.DISPLAY;
const r = needsX ? spawnSync("xvfb-run", ["-a", "-s", "-screen 0 1440x900x24", "npx", "vitest", "run"], { stdio: "inherit" }) : spawnSync("npx", ["vitest", "run"], { stdio: "inherit", shell: process.platform === "win32" });
process.exit(r.status ?? 1);

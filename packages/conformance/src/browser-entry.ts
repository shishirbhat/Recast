import { runAll, type Core } from "./run-cases.js";
(globalThis as unknown as { RecastConformance: { run: (core: Core) => ReturnType<typeof runAll> } }).RecastConformance = { run: runAll };

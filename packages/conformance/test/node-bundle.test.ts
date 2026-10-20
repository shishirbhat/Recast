import { pathToFileURL } from "node:url";
import path from "node:path";
import { CORE_DIST } from "../src/paths.js";
import { conformanceSuite } from "./shared.js";
conformanceSuite("Node (built ESM bundle)", async () => import(pathToFileURL(path.join(CORE_DIST, "recast-core.esm.js")).href));

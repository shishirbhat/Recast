import { afterEach, expect } from "vitest";
import { withContractCheck } from "../src/contract";

/** Every response a test produces is checked against the contract (paths outside it, like a deliberate 404, are skipped). */
const breaches: string[] = [];
export const guard = <T extends { handle(req: Request): Promise<Response> }>(api: T): T => withContractCheck(api, breaches);
afterEach(() => { const found = breaches.splice(0); expect(found, "responses that break the API contract").toEqual([]); });

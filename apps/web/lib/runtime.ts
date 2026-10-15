import { runtimeClientFromEnv, type RuntimeClient } from "@recast/runtime-client";

/**
 * With RUNTIME_URL, RUNTIME_ADMIN_TOKEN and RUNTIME_TENANT_ID set, this talks to the real Agent Runtime.
 * Without them it serves sample data, like the rest of the demo. The admin token never leaves the server.
 */
const g = globalThis as unknown as { __recastRuntime?: RuntimeClient };
export const getRuntime = (): RuntimeClient => (g.__recastRuntime ??= runtimeClientFromEnv(process.env));
export const runtimeIsDemo = () => !(process.env.RUNTIME_URL && process.env.RUNTIME_ADMIN_TOKEN && process.env.RUNTIME_TENANT_ID);

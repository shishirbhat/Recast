export const API_VERSION = "1.0.0";
/** Versions we still answer but have announced the end of. Clients are told on every response, in headers. */
export interface Deprecation { version: string; sunset: string }

export function checkVersion(requested: string | null, deprecated: Deprecation[] = []): { ok: true; headers: Record<string, string> } | { ok: false; message: string } {
  const headers: Record<string, string> = { "Recast-Schema-Version": API_VERSION };
  if (!requested) return { ok: true, headers };
  if (!/^\d+\.\d+\.\d+$/.test(requested)) return { ok: false, message: "X-Recast-Version must look like 1.0.0" };
  const dep = deprecated.find((d) => d.version === requested);
  if (dep) { headers["Deprecation"] = "true"; headers["Sunset"] = new Date(dep.sunset).toUTCString(); return { ok: true, headers }; }
  if (requested.split(".")[0] !== API_VERSION.split(".")[0]) return { ok: false, message: `this endpoint serves major version ${API_VERSION.split(".")[0]}; got ${requested}` };
  headers["Recast-Schema-Version"] = API_VERSION;
  return { ok: true, headers };
}

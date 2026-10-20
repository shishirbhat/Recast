import { OPENAPI } from "./openapi";

/**
 * The parts of the contract clients depend on, reduced to a comparable surface, and the rules for what counts as breaking
 * (docs/18-api-compatibility.md). A committed snapshot (contract/v1.json) is the baseline; the test fails on any breaking
 * change against it, and additions pass.
 */
export interface Surface {
  operations: Record<string, string[]>;
  schemas: Record<string, { properties: string[]; required: string[]; consts: Record<string, unknown> }>;
}
const REQUEST_SCHEMAS = new Set(["ResolveRequest", "PlaceRequest"]);

export function surface(doc: { paths: Record<string, Record<string, any>>; components: { schemas: Record<string, any> } } = OPENAPI as never): Surface {
  const operations: Surface["operations"] = {};
  for (const [p, ops] of Object.entries(doc.paths)) for (const [m, op] of Object.entries(ops)) operations[`${m.toUpperCase()} ${p}`] = Object.keys(op.responses).sort();
  const schemas: Surface["schemas"] = {};
  for (const [name, s] of Object.entries(doc.components.schemas)) {
    const props = (s.properties ?? {}) as Record<string, any>;
    schemas[name] = { properties: Object.keys(props).sort(), required: [...(s.required ?? [])].sort(), consts: Object.fromEntries(Object.entries(props).filter(([, v]) => v && "const" in v).map(([k, v]) => [k, v.const])) };
  }
  return { operations, schemas };
}

export function breakingChanges(before: Surface, after: Surface): string[] {
  const out: string[] = [];
  for (const [op, statuses] of Object.entries(before.operations)) {
    const now = after.operations[op]; if (!now) { out.push(`${op} was removed`); continue; }
    for (const s of statuses) if (s.startsWith("2") && !now.includes(s)) out.push(`${op} no longer answers ${s}`);
  }
  for (const [name, s] of Object.entries(before.schemas)) {
    const now = after.schemas[name]; if (!now) { out.push(`schema ${name} was removed`); continue; }
    if (REQUEST_SCHEMAS.has(name)) { for (const r of now.required) if (!s.required.includes(r)) out.push(`${name}.${r} became required`); continue; }
    for (const p of s.properties) if (!now.properties.includes(p)) out.push(`${name}.${p} was removed`);
    for (const r of s.required) if (!now.required.includes(r)) out.push(`${name}.${r} is no longer always present`);
    for (const [k, v] of Object.entries(s.consts)) if (JSON.stringify(now.consts[k]) !== JSON.stringify(v)) out.push(`${name}.${k} changed from ${JSON.stringify(v)}`);
  }
  return out;
}

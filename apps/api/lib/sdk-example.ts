// Shown on /docs exactly as written, and run against the built server by test/docs.test.ts.
import { Recast, RateLimitError } from "@recast/sdk";

export async function example(apiKey: string, baseUrl: string) {
  const recast = new Recast({ apiKey, baseUrl });   // baseUrl: the address your Recast contact gave you

  const r = await recast.resolve({ raw: "Meera Iyer, meera@example.com", target: { destination: "gmail" } });
  if (r.status === "resolved") {
    console.log(r.object.type, r.object.fields);          // "Person", { name, email, ... }
    console.log(r.routing?.action, r.routing?.consent);    // what placing it would do, and the consent it needs
  } else {
    console.log(r.status, r.reason);                       // ambiguous or unresolved: ask the person, never guess
  }

  try {
    const many = await recast.resolveBatch([{ raw: "Launch dinner 2026-11-14" }, { raw: "Indiranagar, Bengaluru 560038" }]);
    console.log(many.map((x) => x.status));
  } catch (e) {
    if (e instanceof RateLimitError) console.log(`slow down for ${e.retryAfterSec}s`);
    else throw e;
  }
  return r;
}

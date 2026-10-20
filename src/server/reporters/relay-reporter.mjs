// A node:test reporter for Relay's test panel: one JSON line per finished test, with Node's own file/line/column.
export default async function* relayReporter(source) {
  for await (const event of source) {
    if (event.type !== "test:pass" && event.type !== "test:fail") continue;
    const d = event.data;
    const err = d.details?.error;
    yield JSON.stringify({
      relay: 1,
      name: d.name,
      file: d.file ?? null,
      line: d.line ?? null,
      column: d.column ?? null,
      nesting: d.nesting,
      type: d.details?.type ?? "test",
      status: d.skip !== undefined ? "skip" : d.todo !== undefined ? "todo" : event.type === "test:pass" ? "pass" : "fail",
      durationMs: d.details?.duration_ms ?? null,
      error: err ? String(err.cause?.message ?? err.message ?? err).slice(0, 4000) : null,
      failureType: err?.failureType ?? null,
    }) + "\n";
  }
}

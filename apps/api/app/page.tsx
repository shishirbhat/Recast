export default function Home() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "64px 16px", lineHeight: 1.5 }}>
      <h1 style={{ fontSize: 36, margin: 0 }}>Recast API</h1>
      <p style={{ fontSize: 20, marginTop: 8 }}>Turn any screen object into a typed, routed action.</p>
      <p>Your agent sees a name, an email, a date, an address. It does not know what any of it means, or where it goes. One call turns raw text into a Person, Event, Location, Product, Paper or Document, with confidence, provenance and a route to Calendar, Gmail, Sheets, Tasks or Notion.</p>
      <pre tabIndex={0} style={{ background: "var(--code)", border: "1px solid var(--line)", borderRadius: 12, padding: 16, overflowX: "auto" }}>{`curl -X POST https://api.recast.example/v1/resolve \\
  -H "Authorization: Bearer sk_..." \\
  -H "Content-Type: application/json" \\
  -d '{"input":{"raw":"Meera Iyer, meera@x.com"},"target":{"destination":"google_calendar"}}'`}</pre>
      <p>Every answer says which stage produced it, how sure each field is, and what it would take to place it. <a href="/docs">Read the docs</a> · <a href="/v1/health">Status</a></p>
    </main>
  );
}

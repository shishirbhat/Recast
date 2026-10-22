// Connections: the Google app's ID and secret (kept by the app, never shown again), and sign-in in the person's browser.
interface Api { google(g: unknown): Promise<{ ok: boolean; message: string }>; googleStatus(): Promise<{ configured: boolean; serverNote: string }>; status(): Promise<Record<string, unknown>>; window(w: string): Promise<boolean>; boot(): Promise<{ theme: "dark" | "light" }>; on(c: string, f: (v: any) => void): void }
const api = (window as unknown as { recastDesktop: Api }).recastDesktop;
const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector<T>(s)!;
async function refresh() {
  const g = await api.googleStatus(); const st = await api.status();
  const allowed = [st["connected"] ? "Calendar" : "", st["gmail"] ? "Gmail drafts" : "", st["tasks"] ? "Tasks" : "", st["docs"] ? "Docs" : ""].filter(Boolean);
  $("#g-state").innerHTML = st["connected"] ? `<span class="ok">Connected.</span> Allowed: ${allowed.join(", ")}.` : g.configured ? "Set up. Sign in with Google to connect an account." : "Not set up yet.";
  $("#server-note").textContent = g.serverNote;
}
$("#g-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const r = await api.google({ clientId: $<HTMLInputElement>("#g-id").value, clientSecret: $<HTMLInputElement>("#g-secret").value });
  $("#g-msg").textContent = r.message; if (r.ok) { $<HTMLInputElement>("#g-secret").value = ""; void refresh(); }
});
$("#g-signin").addEventListener("click", () => void api.window("signin"));
$("#o-open").addEventListener("click", () => void api.window("signin"));
api.on("recast:theme", (t: "dark" | "light") => { document.documentElement.dataset["theme"] = t; });
void api.boot().then((b) => { document.documentElement.dataset["theme"] = b.theme; });
addEventListener("focus", () => void refresh());
void refresh();

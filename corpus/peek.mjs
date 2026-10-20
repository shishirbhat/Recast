// Prints what a person sees on a page, for labelling ground truth. It does NOT run the extractor.
//   node peek.mjs <id> [<id>...]
import { manifest, launch, openSnapshot } from "./browser.mjs";
const ids = process.argv.slice(2), all = manifest();
const browser = await launch();
for (const id of ids) {
  const e = all.find((x) => x.id === id || x.id.endsWith(id));
  if (!e) { console.log(`?? ${id}`); continue; }
  const { ctx, page } = await openSnapshot(browser, e);
  const chars = Number(process.env.CHARS ?? 700);
  const v = await page.evaluate((chars) => {
    const t = (s) => [...document.querySelectorAll(s)].slice(0, 6).map((x) => x.textContent.replace(/\s+/g, " ").trim()).filter(Boolean);
    const body = document.body ? document.body.innerText.replace(/\s+/g, " ").trim() : "";
    return { title: document.title, h1: t("h1"), h2: t("h2").slice(0, 4), mailto: [...document.querySelectorAll('a[href^="mailto:"]')].slice(0, 3).map((a) => a.getAttribute("href")), tel: [...document.querySelectorAll('a[href^="tel:"]')].slice(0, 3).map((a) => a.getAttribute("href")), time: [...document.querySelectorAll("time")].slice(0, 4).map((x) => (x.getAttribute("datetime") ?? "") + " | " + x.textContent.trim()), address: t("address").slice(0, 2), text: body.slice(0, chars) };
  }, chars);
  console.log(`\n=== ${e.id}  ${e.url}\ntitle: ${v.title}\nh1: ${JSON.stringify(v.h1)}${v.h2.length ? "\nh2: " + JSON.stringify(v.h2) : ""}${v.mailto.length ? "\nmailto: " + v.mailto : ""}${v.tel.length ? "\ntel: " + v.tel : ""}${v.time.length ? "\ntime: " + JSON.stringify(v.time) : ""}${v.address.length ? "\naddress: " + JSON.stringify(v.address) : ""}\ntext: ${v.text}`);
  await ctx.close();
}
await browser.close();

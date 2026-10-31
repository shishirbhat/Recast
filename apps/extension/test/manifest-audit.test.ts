import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f: string) => readFileSync(path.join(root, f), "utf8");
const manifest = JSON.parse(read("dist/manifest.json"));

describe("production manifest: least privilege", () => {
  it("asks for exactly activeTab, scripting and storage; no host access, no content scripts injected on its own", () => {
    expect(manifest.manifest_version).toBe(3);
    // storage is for chrome.storage.session only (the objects you carry between tabs; memory, cleared with the browser).
    expect(manifest.permissions.sort()).toEqual(["activeTab", "scripting", "storage"]);
    // The one optional host: the Recast program on this computer (real Google Calendar), asked for only when the person
    // presses Connect in the popup. No site on the web.
    expect(manifest.optional_host_permissions).toEqual(["http://localhost/*"]);
    for (const k of ["host_permissions", "optional_permissions", "content_scripts", "web_accessible_resources", "externally_connectable", "declarative_net_request", "devtools_page", "omnibox", "side_panel"]) {
      expect(manifest[k], k).toBeUndefined();
    }
    expect(manifest.background).toEqual({ service_worker: "background.js" });
    // The one command is the shortcut that grants activeTab for the current tab; it reaches no other tab.
    expect(Object.keys(manifest.commands)).toEqual(["recast-clay"]);
  });
  it("has a strict CSP with no eval and no remote script", () => {
    const csp: string = manifest.content_security_policy.extension_pages;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    // The only network the extension can reach: the Recast program on this computer.
    expect(csp).toMatch(/connect-src http:\/\/localhost:8787(;|$)/);
    expect(csp).not.toMatch(/unsafe-eval|unsafe-inline|https:/);
    expect(csp.replace("connect-src http://localhost:8787", "")).not.toMatch(/http:/);
  });
  it("the test build differs from production only by host permissions for local test servers", () => {
    const t = JSON.parse(read("dist-test/manifest.json"));
    const { host_permissions, ...rest } = t;
    expect(host_permissions).toEqual(["http://127.0.0.1/*", "http://localhost/*"]);
    expect(rest).toEqual(manifest);
  });
});

describe("built code: no dynamic execution, no network, no storage, no unsafe HTML", () => {
  it("the service worker keeps state only in session storage and talks only to the Recast program on this computer", () => {
    const src = read("dist/background.js");
    // One fetch, to http://localhost:8787/ext/…, which only works after the person granted localhost and allowed the extension there.
    expect(read("src/background.ts").match(/\bfetch\s*\([^,]*/g)).toEqual(["fetch(`${LINK}/ext/${route}`"]);
    expect(read("src/background.ts")).toContain('LINK = "http://localhost:8787"');
    for (const pat of [/\bnew Function\s*\(/, /\beval\s*\(/, /XMLHttpRequest/, /WebSocket/, /sendBeacon/, /importScripts/, /chrome\.storage\.(sync|managed)/, /chrome\.cookies/, /chrome\.tabs\.create/, /chrome\.downloads/]) {
      expect(src, String(pat)).not.toMatch(pat);
    }
    expect(src).toContain("chrome.storage.session");
    // chrome.storage.local holds exactly three keys: the confirmation setting, the saved workflows (definitions the
    // machine checked) and the person's defaults (destination names and minutes, checked as read): never objects or page content.
    const src2 = read("src/background.ts");
    expect(src2.match(/chrome\.storage\.local\.(get|set)\([^)]*\)/g)).toEqual(["chrome.storage.local.get(CONFIRM)", "chrome.storage.local.get(PRESETS)", "chrome.storage.local.get(WORKFLOWS)", "chrome.storage.local.set({ [WORKFLOWS]: e.items })", "chrome.storage.local.set({ [PRESETS]: e.presets })", "chrome.storage.local.set({ [CONFIRM]: level })"]);
    expect(src2).toContain('const WORKFLOWS = "workflows"');
    expect(src2).toContain('const CONFIRM = "confirmLevel"');
    // The only tab change it makes: bringing a destination's tab to the front when the person chose it in the module.
    expect(read("src/background.ts").match(/chrome\.(tabs|windows)\.update\([^)]*\)/g)).toEqual(["chrome.tabs.update(tabId, { active: true })", "chrome.windows.update(t.windowId, { focused: true })"]);
  });
  it("the clay layer in the page has no network and no storage of its own (the registry it reads is data only)", () => {
    const src = read("dist/clay-content.js");
    expect(src).toContain("google-calendar.calendar");
    for (const pat of [/\bnew Function\s*\(/, /\beval\s*\(/, /\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /sendBeacon/, /localStorage/, /sessionStorage/, /indexedDB/, /chrome\.storage/, /document\.cookie/]) {
      expect(src, String(pat)).not.toMatch(pat);
    }
  });
  for (const f of ["dist/page.js", "dist/popup.js"]) {
    it(`${f}`, () => {
      const src = read(f);
      for (const pat of [/\bnew Function\s*\(/, /\beval\s*\(/, /\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /sendBeacon/, /importScripts/, /\bimport\s*\(/, /localStorage/, /sessionStorage/, /indexedDB/, /chrome\.storage/, /chrome\.cookies/, /document\.cookie/, /chrome\.tabs\.(create|update)/, /chrome\.downloads/]) {
        expect(src, String(pat)).not.toMatch(pat);
      }
    });
  }
  it("the page script sends nothing; the popup sends: the Recast command for its tab, the confirmation setting, and the calendar link check", () => {
    expect(read("dist/page.js")).not.toMatch(/chrome\.runtime\.sendMessage/);
    expect(read("src/popup.ts").match(/chrome\.runtime\.sendMessage\([^)]*\)/g)).toEqual(['chrome.runtime.sendMessage({ type: "invoke", tabId })', 'chrome.runtime.sendMessage({ type: "confirm" })', 'chrome.runtime.sendMessage({ type: "confirm", level: r.value as "none" | "high" })', 'chrome.runtime.sendMessage({ type: "link" })']);
    expect(read("src/background.ts")).toMatch(/msg\.type === "confirm" && fromExtensionPage\(sender\)/);
    expect(read("src/background.ts")).toMatch(/msg\.type === "link" && fromExtensionPage\(sender\)/);
  });
  it("the worker accepts the command and activation only from the extension's own pages, never from a content script", () => {
    const src = read("src/background.ts");
    expect(src).toMatch(/msg\.type === "invoke" && fromExtensionPage\(sender\)/);
    expect(src).toMatch(/msg\.type === "activate" && fromExtensionPage\(sender\)/);
    expect(src).toMatch(/sender\.id === chrome\.runtime\.id && !!sender\.url\?\.startsWith\(chrome\.runtime\.getURL\(""\)\)/);
  });
  it("the popup never parses page-controlled strings as HTML", () => {
    const src = read("src/popup.ts");
    for (const pat of [/innerHTML/, /outerHTML/, /insertAdjacentHTML/, /document\.write/, /DOMParser/, /createContextualFragment/]) expect(src, String(pat)).not.toMatch(pat);
  });
  it("the production popup has no test hook that picks a tab from the URL", () => {
    expect(read("dist/popup.js")).not.toContain(`"tabId"`);
    expect(read("dist/popup.js")).not.toContain("URLSearchParams");
    expect(read("dist-test/popup.js")).toContain("URLSearchParams");
  });
  it("popup.html loads only local scripts and styles", () => {
    const html = read("dist/popup.html");
    expect(html).not.toMatch(/<script(?![^>]*\bsrc="[a-z.]+")/);
    expect(html).not.toMatch(/https?:\/\//);
    expect(existsSync(path.join(root, "dist/popup.js"))).toBe(true);
  });
});

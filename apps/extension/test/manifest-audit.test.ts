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
    for (const k of ["host_permissions", "optional_permissions", "optional_host_permissions", "content_scripts", "web_accessible_resources", "externally_connectable", "declarative_net_request", "devtools_page", "omnibox", "side_panel"]) {
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
    expect(csp).toContain("connect-src 'none'");
    expect(csp).not.toMatch(/unsafe-eval|unsafe-inline|https?:/);
  });
  it("the test build differs from production only by 127.0.0.1 host permission", () => {
    const t = JSON.parse(read("dist-test/manifest.json"));
    const { host_permissions, ...rest } = t;
    expect(host_permissions).toEqual(["http://127.0.0.1/*"]);
    expect(rest).toEqual(manifest);
  });
});

describe("built code: no dynamic execution, no network, no storage, no unsafe HTML", () => {
  it("the service worker keeps state only in session storage and talks to no network", () => {
    const src = read("dist/background.js");
    for (const pat of [/\bnew Function\s*\(/, /\beval\s*\(/, /\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /sendBeacon/, /importScripts/, /chrome\.storage\.(local|sync|managed)/, /chrome\.cookies/, /chrome\.tabs\.create/, /chrome\.downloads/]) {
      expect(src, String(pat)).not.toMatch(pat);
    }
    expect(src).toContain("chrome.storage.session");
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
  it("the page script sends nothing; the popup sends exactly one message, the Recast command for the tab it was opened on", () => {
    expect(read("dist/page.js")).not.toMatch(/chrome\.runtime\.sendMessage/);
    expect(read("src/popup.ts").match(/chrome\.runtime\.sendMessage\([^)]*\)/g)).toEqual(['chrome.runtime.sendMessage({ type: "invoke", tabId })']);
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

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f: string) => readFileSync(path.join(root, f), "utf8");
const manifest = JSON.parse(read("dist/manifest.json"));

describe("production manifest: least privilege", () => {
  it("asks for exactly activeTab and scripting, and nothing else", () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions.sort()).toEqual(["activeTab", "scripting"]);
    for (const k of ["host_permissions", "optional_permissions", "optional_host_permissions", "content_scripts", "background", "web_accessible_resources", "externally_connectable", "commands", "declarative_net_request", "devtools_page", "omnibox", "side_panel"]) {
      expect(manifest[k], k).toBeUndefined();
    }
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
  for (const f of ["dist/page.js", "dist/popup.js"]) {
    it(`${f}`, () => {
      const src = read(f);
      for (const pat of [/\bnew Function\s*\(/, /\beval\s*\(/, /\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /sendBeacon/, /importScripts/, /\bimport\s*\(/, /localStorage/, /sessionStorage/, /indexedDB/, /chrome\.storage/, /chrome\.cookies/, /document\.cookie/, /chrome\.tabs\.(create|update)/, /chrome\.downloads/, /chrome\.runtime\.sendMessage/]) {
        expect(src, String(pat)).not.toMatch(pat);
      }
    });
  }
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

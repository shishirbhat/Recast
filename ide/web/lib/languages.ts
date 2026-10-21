import type { Extension } from "@codemirror/state";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { python } from "@codemirror/lang-python";

/**
 * Language modes, as VS Code's "Change Language Mode" lists them. `prettier` names the parser Format Document uses;
 * a language without one can't be formatted, and the command says so.
 */
export interface Language {
  id: string;
  label: string;
  exts: string[];
  mode: () => Extension;
  prettier?: string;
}

export const LANGUAGES: Language[] = [
  { id: "javascript", label: "JavaScript", exts: ["js", "mjs", "cjs"], mode: () => javascript(), prettier: "babel" },
  { id: "javascriptreact", label: "JavaScript JSX", exts: ["jsx"], mode: () => javascript({ jsx: true }), prettier: "babel" },
  { id: "typescript", label: "TypeScript", exts: ["ts", "mts", "cts"], mode: () => javascript({ typescript: true }), prettier: "typescript" },
  { id: "typescriptreact", label: "TypeScript JSX", exts: ["tsx"], mode: () => javascript({ jsx: true, typescript: true }), prettier: "typescript" },
  { id: "json", label: "JSON", exts: ["json", "jsonc"], mode: () => json(), prettier: "json" },
  { id: "markdown", label: "Markdown", exts: ["md", "mdx", "markdown"], mode: () => markdown(), prettier: "markdown" },
  { id: "css", label: "CSS", exts: ["css"], mode: () => css(), prettier: "css" },
  { id: "html", label: "HTML", exts: ["html", "htm"], mode: () => html(), prettier: "html" },
  { id: "python", label: "Python", exts: ["py"], mode: () => python() },
  { id: "plaintext", label: "Plain Text", exts: ["txt"], mode: () => [] },
];

export const languageById = (id: string) => LANGUAGES.find((l) => l.id === id) ?? LANGUAGES.at(-1)!;

export function languageIdFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return LANGUAGES.find((l) => l.exts.includes(ext))?.id ?? "plaintext";
}

/**
 * Symbols in one file for Go to Symbol in Editor ("@"), without a language server: declarations recognised line by
 * line (JS/TS, Python, Markdown headings), the same set the server's workspace-symbol search finds, plus methods.
 */
export interface FileSymbol {
  name: string;
  kind: string;
  line: number;
}

const DECLARATION = /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(function\*?|class|interface|type|enum|const|let|var|def)\s+([A-Za-z_$][\w$]*)/;
const METHOD = /^\s+(?:(?:public|private|protected|static|readonly|override|async|get|set)\s+)*\*?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::\s*[^={]+)?\{\s*$/;
const HEADING = /^(#{1,6})\s+(.+?)\s*#*$/;
const NOT_METHODS = new Set(["if", "for", "while", "switch", "catch", "function", "return", "with", "else"]);

export function fileSymbols(text: string, languageId: string): FileSymbol[] {
  const out: FileSymbol[] = [];
  const lines = text.split("\n");
  let fenced = false;
  lines.forEach((l, i) => {
    if (languageId === "markdown") {
      if (/^\s*(```|~~~)/.test(l)) fenced = !fenced;
      const h = !fenced && HEADING.exec(l);
      if (h) out.push({ name: h[2]!, kind: `h${h[1]!.length}`, line: i + 1 });
      return;
    }
    const d = DECLARATION.exec(l);
    if (d) return void out.push({ name: d[2]!, kind: d[1]!.replace("*", ""), line: i + 1 });
    const m = METHOD.exec(l);
    if (m && !NOT_METHODS.has(m[1]!)) out.push({ name: m[1]!, kind: "method", line: i + 1 });
  });
  return out;
}

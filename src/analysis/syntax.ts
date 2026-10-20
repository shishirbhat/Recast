import ts from "typescript";

/** A syntax error with 1-based positions. */
export interface SyntaxProblem {
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  message: string;
}

const SCRIPT = /\.(m|c)?(j|t)sx?$/;

/**
 * Syntax errors only: the TypeScript parser for JS/TS (no type checking, no project configuration), JSON.parse for JSON.
 * Other languages report nothing rather than guess. This is a real parser result, not a linter.
 */
export function syntaxProblems(path: string, text: string): SyntaxProblem[] {
  if (path.endsWith(".json")) {
    try {
      JSON.parse(text);
      return [];
    } catch (e) {
      const m = /position (\d+)/.exec(String((e as Error).message));
      const at = m ? Number(m[1]) : text.length;
      const before = text.slice(0, at);
      const line = before.split("\n").length;
      const col = at - before.lastIndexOf("\n");
      return [{ line, col, endLine: line, endCol: col + 1, message: String((e as Error).message) }];
    }
  }
  if (!SCRIPT.test(path) || path.endsWith(".d.ts")) return [];
  const out = ts.transpileModule(text, { fileName: path, reportDiagnostics: true, compilerOptions: { jsx: ts.JsxEmit.Preserve, allowJs: true, noEmit: true } });
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false);
  return (out.diagnostics ?? []).filter((d) => d.start !== undefined).slice(0, 100).map((d) => {
    const s = sf.getLineAndCharacterOfPosition(d.start!);
    const e = sf.getLineAndCharacterOfPosition(d.start! + (d.length ?? 1));
    return { line: s.line + 1, col: s.character + 1, endLine: e.line + 1, endCol: e.character + 1, message: ts.flattenDiagnosticMessageText(d.messageText, "\n") };
  });
}

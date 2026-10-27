import ts from "typescript";

/**
 * Document symbols, as VS Code's Outline and "Go to Symbol" list them. JavaScript and TypeScript are parsed with the
 * TypeScript compiler's parser (syntax only: no type checking, so names are exact but references are not resolved).
 * Python and Markdown use their line structure (def/class, headings).
 */

export type SymbolKind = "function" | "class" | "method" | "property" | "variable" | "constant" | "interface" | "type" | "enum" | "namespace" | "heading" | "module";

export interface DocSymbol {
  name: string;
  kind: SymbolKind;
  /** 1-based. */
  line: number;
  col: number;
  endLine: number;
  /** Nesting depth (0 = top level) and the enclosing symbol's name. */
  depth: number;
  container: string | null;
}

const SCRIPT = /\.(m|c)?(j|t)sx?$/;

export function symbolsOf(path: string, text: string): DocSymbol[] {
  if (SCRIPT.test(path)) return scriptSymbols(path, text);
  if (/\.py$/.test(path)) return pythonSymbols(text);
  if (/\.(md|mdx|markdown)$/.test(path)) return markdownSymbols(text);
  return [];
}

function scriptSymbols(path: string, text: string): DocSymbol[] {
  const kind = /\.tsx$/.test(path) ? ts.ScriptKind.TSX : /\.(m|c)?ts$/.test(path) ? ts.ScriptKind.TS : /\.jsx$/.test(path) ? ts.ScriptKind.JSX : ts.ScriptKind.JS;
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  const out: DocSymbol[] = [];
  const add = (name: string, k: SymbolKind, node: ts.Node, depth: number, container: string | null) => {
    const start = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    const end = sf.getLineAndCharacterOfPosition(node.getEnd());
    out.push({ name, kind: k, line: start.line + 1, col: start.character + 1, endLine: end.line + 1, depth, container });
  };
  const nameOf = (n: ts.Node & { name?: ts.Node }) => (n.name && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name) || ts.isPrivateIdentifier(n.name) || ts.isNumericLiteral(n.name)) ? n.name.text : null);
  const visit = (node: ts.Node, depth: number, container: string | null) => {
    let name: string | null = null;
    let k: SymbolKind | null = null;
    if (ts.isFunctionDeclaration(node)) (name = nameOf(node) ?? "default"), (k = "function");
    else if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) (name = nameOf(node) ?? "default"), (k = "class");
    else if (ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node)) (name = nameOf(node)), (k = "method");
    else if (ts.isConstructorDeclaration(node)) (name = "constructor"), (k = "method");
    else if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) (name = nameOf(node)), (k = "property");
    else if (ts.isMethodSignature(node)) (name = nameOf(node)), (k = "method");
    else if (ts.isInterfaceDeclaration(node)) (name = node.name.text), (k = "interface");
    else if (ts.isTypeAliasDeclaration(node)) (name = node.name.text), (k = "type");
    else if (ts.isEnumDeclaration(node)) (name = node.name.text), (k = "enum");
    else if (ts.isModuleDeclaration(node)) (name = nameOf(node)), (k = "namespace");
    else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      // Variables count at the top level and as named function values; locals inside functions don't.
      const fn = node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer) || ts.isClassExpression(node.initializer));
      const top = depth === 0;
      if (top || fn) {
        name = node.name.text;
        const isConst = (node.parent.flags & ts.NodeFlags.Const) !== 0;
        k = fn ? (node.initializer && ts.isClassExpression(node.initializer) ? "class" : "function") : isConst ? "constant" : "variable";
      }
    } else if (ts.isPropertyAssignment(node) && depth > 0 && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) (name = nameOf(node)), (k = "method");
    if (name && k) add(name, k, node, depth, container);
    const inner = name && k && k !== "variable" && k !== "constant" && k !== "property";
    // Descend into declarations that contain more declarations; skip function bodies' locals (except nested named functions).
    ts.forEachChild(node, (child) => visit(child, inner ? depth + 1 : depth, inner ? name : container));
  };
  ts.forEachChild(sf, (n) => visit(n, 0, null));
  return out;
}

function pythonSymbols(text: string): DocSymbol[] {
  const out: DocSymbol[] = [];
  const stack: { indent: number; name: string }[] = [];
  text.split("\n").forEach((l, i) => {
    const m = /^(\s*)(async\s+def|def|class)\s+([A-Za-z_]\w*)/.exec(l);
    if (!m) return;
    const indent = m[1]!.length;
    while (stack.length && stack.at(-1)!.indent >= indent) stack.pop();
    const container = stack.at(-1)?.name ?? null;
    out.push({ name: m[3]!, kind: m[2] === "class" ? "class" : container ? "method" : "function", line: i + 1, col: indent + 1, endLine: i + 1, depth: stack.length, container });
    stack.push({ indent, name: m[3]! });
  });
  return out;
}

function markdownSymbols(text: string): DocSymbol[] {
  const out: DocSymbol[] = [];
  const stack: { level: number; name: string }[] = [];
  let fence = false;
  text.split("\n").forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    const m = !fence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(l);
    if (!m) return;
    const level = m[1]!.length;
    while (stack.length && stack.at(-1)!.level >= level) stack.pop();
    out.push({ name: m[2]!, kind: "heading", line: i + 1, col: 1, endLine: i + 1, depth: stack.length, container: stack.at(-1)?.name ?? null });
    stack.push({ level, name: m[2]! });
  });
  return out;
}

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import ts from "typescript";

/**
 * The live dependency map: who imports what, which exported interfaces changed, who consumes them, and which tests cover them.
 *
 * Everything here comes from parsing source with the TypeScript compiler's parser (concrete syntax, no type checker, no LLM).
 * Each relationship carries the kind of evidence that established it. What the parser cannot see (computed dynamic imports,
 * other languages, runtime coupling such as HTTP calls) is reported in `gaps`, never guessed.
 *
 * Parsing is cached per file content hash, and files are re-read only when their size or mtime changed, so refreshing after
 * an edit costs one parse of the edited file.
 */

export const CODE_EXT = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const isCode = (p: string) => CODE_EXT.some((e) => p.endsWith(e)) && !p.endsWith(".d.ts");
export const isTestFile = (p: string) => /(^|\/)__tests__\/|[._-](test|spec)\.[cm]?[jt]sx?$/.test(p);

export interface ImportEdge {
  from: string;
  /** Repo-relative file, `pkg:<name>` for a package, or null if a relative import didn't resolve. */
  to: string | null;
  spec: string;
  /** Imported names as exported by the target; "*" for namespace / side-effect / require. */
  names: { imported: string; local: string }[];
  line: number;
  kind: "import" | "re-export" | "dynamic-import" | "require";
}

export interface ExportInfo {
  name: string;
  line: number;
  kind: "function" | "class" | "variable" | "type" | "interface" | "enum" | "default" | "re-export";
  /** Normalized declared interface: parameters and annotated types, or the full type declaration. */
  signature: string;
  /** For functions that return object literals: the union of the keys they return (concrete, from return statements). */
  returnKeys: string[] | null;
  /** Hash of the whole declaration, so an implementation change is visible even when the signature is not. */
  bodyHash: string;
}

/** A property read on a value produced by an imported function, e.g. `const u = getUser(); u.name`. */
export interface PropertyUse {
  symbol: string;
  prop: string;
  line: number;
}

export interface ModuleInfo {
  path: string;
  hash: string;
  imports: ImportEdge[];
  exports: ExportInfo[];
  uses: PropertyUse[];
  gaps: string[];
}

const norm = (s: string) => s.replace(/\s+/g, " ").replace(/\s*([(){}\[\]:;,<>=|&?])\s*/g, "$1").trim();
const sha = (s: string) => createHash("sha1").update(s).digest("hex");

function scriptKind(p: string): ts.ScriptKind {
  if (p.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (p.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.[cm]?ts$/.test(p)) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

/** Keys of object literals returned directly by a function body (nested functions excluded). */
function returnKeysOf(body: ts.Node | undefined): string[] | null {
  if (!body) return null;
  if (ts.isObjectLiteralExpression(body)) return keysOf(body);
  if (ts.isParenthesizedExpression(body) && ts.isObjectLiteralExpression(body.expression)) return keysOf(body.expression);
  const keys = new Set<string>();
  let found = false;
  const visit = (n: ts.Node) => {
    if (ts.isFunctionLike(n) && n !== body) return;
    if (ts.isReturnStatement(n) && n.expression) {
      let e = n.expression;
      while (ts.isParenthesizedExpression(e) || ts.isAwaitExpression(e) || ts.isAsExpression(e)) e = e.expression;
      if (ts.isObjectLiteralExpression(e)) {
        found = true;
        for (const k of keysOf(e)) keys.add(k);
      }
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(body, visit);
  return found ? [...keys].sort() : null;
}
function keysOf(o: ts.ObjectLiteralExpression): string[] {
  const out: string[] = [];
  for (const p of o.properties) {
    if ((ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p) || ts.isMethodDeclaration(p)) && p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) out.push(p.name.text);
    if (ts.isSpreadAssignment(p)) out.push("...");
  }
  return out;
}

function fnSignature(name: string, fn: ts.SignatureDeclaration, sf: ts.SourceFile): string {
  const params = fn.parameters.map((p) => p.getText(sf)).join(", ");
  const ret = fn.type ? `: ${fn.type.getText(sf)}` : "";
  const typeParams = fn.typeParameters ? `<${fn.typeParameters.map((t) => t.getText(sf)).join(", ")}>` : "";
  return norm(`${name}${typeParams}(${params})${ret}`);
}

const hasExport = (n: ts.Node) => !!(ts.canHaveModifiers(n) && ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
const hasDefault = (n: ts.Node) => !!(ts.canHaveModifiers(n) && ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword));

/** Parse one file. Pure: depends only on the path (for resolution and script kind) and the text. */
export function parseModule(path: string, text: string, resolve: (from: string, spec: string) => string | null): ModuleInfo {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind(path));
  const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const imports: ImportEdge[] = [];
  const exports: ExportInfo[] = [];
  const gaps: string[] = [];
  const target = (spec: string) => (spec.startsWith(".") || spec.startsWith("/") ? resolve(path, spec) : `pkg:${spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]}`);
  const addExport = (e: Omit<ExportInfo, "bodyHash">, node: ts.Node) => exports.push({ ...e, bodyHash: sha(norm(node.getText(sf))) });

  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const spec = st.moduleSpecifier.text;
      const names: ImportEdge["names"] = [];
      const c = st.importClause;
      if (c?.name) names.push({ imported: "default", local: c.name.text });
      if (c?.namedBindings && ts.isNamespaceImport(c.namedBindings)) names.push({ imported: "*", local: c.namedBindings.name.text });
      if (c?.namedBindings && ts.isNamedImports(c.namedBindings)) for (const el of c.namedBindings.elements) names.push({ imported: (el.propertyName ?? el.name).text, local: el.name.text });
      if (!c) names.push({ imported: "*", local: "" });
      imports.push({ from: path, to: target(spec), spec, names, line: line(st), kind: "import" });
      continue;
    }
    if (ts.isExportDeclaration(st)) {
      if (st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
        const spec = st.moduleSpecifier.text;
        const names = st.exportClause && ts.isNamedExports(st.exportClause) ? st.exportClause.elements.map((el) => ({ imported: (el.propertyName ?? el.name).text, local: el.name.text })) : [{ imported: "*", local: "*" }];
        imports.push({ from: path, to: target(spec), spec, names, line: line(st), kind: "re-export" });
        for (const n of names) addExport({ name: n.local, line: line(st), kind: "re-export", signature: `from ${spec}#${n.imported}`, returnKeys: null }, st);
      } else if (st.exportClause && ts.isNamedExports(st.exportClause)) {
        // `export { a, b as c }` of local declarations: resolved below once declarations are known.
        for (const el of st.exportClause.elements) addExport({ name: el.name.text, line: line(st), kind: "variable", signature: `local:${(el.propertyName ?? el.name).text}`, returnKeys: null }, st);
      }
      continue;
    }
    if (ts.isExportAssignment(st)) {
      addExport({ name: "default", line: line(st), kind: "default", signature: norm(st.expression.getText(sf)).slice(0, 200), returnKeys: ts.isArrowFunction(st.expression) || ts.isFunctionExpression(st.expression) ? returnKeysOf(st.expression.body) : null }, st);
      continue;
    }
    if (!hasExport(st)) continue;
    const def = hasDefault(st);
    if (ts.isFunctionDeclaration(st)) {
      const name = def ? "default" : (st.name?.text ?? "default");
      addExport({ name, line: line(st), kind: "function", signature: fnSignature(st.name?.text ?? "default", st, sf), returnKeys: returnKeysOf(st.body) }, st);
    } else if (ts.isClassDeclaration(st)) {
      const members = st.members
        .filter((m) => !(ts.canHaveModifiers(m) && ts.getModifiers(m)?.some((x) => x.kind === ts.SyntaxKind.PrivateKeyword)) && m.name && !ts.isPrivateIdentifier(m.name))
        .map((m) => (ts.isMethodDeclaration(m) ? fnSignature(m.name!.getText(sf), m, sf) : norm(m.getText(sf).replace(/=.*$/s, ""))));
      addExport({ name: def ? "default" : (st.name?.text ?? "default"), line: line(st), kind: "class", signature: `class{${members.join(";")}}`, returnKeys: null }, st);
    } else if (ts.isInterfaceDeclaration(st)) {
      addExport({ name: st.name.text, line: line(st), kind: "interface", signature: norm(st.getText(sf).replace(/^export\s+/, "")), returnKeys: null }, st);
    } else if (ts.isTypeAliasDeclaration(st)) {
      addExport({ name: st.name.text, line: line(st), kind: "type", signature: norm(st.getText(sf).replace(/^export\s+/, "")), returnKeys: null }, st);
    } else if (ts.isEnumDeclaration(st)) {
      addExport({ name: st.name.text, line: line(st), kind: "enum", signature: norm(st.getText(sf).replace(/^export\s+/, "")), returnKeys: null }, st);
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) continue;
        const init = d.initializer;
        if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
          addExport({ name: d.name.text, line: line(d), kind: "function", signature: fnSignature(d.name.text, init, sf), returnKeys: returnKeysOf(init.body) }, d);
        } else {
          const shape = init && ts.isObjectLiteralExpression(init) ? `{${keysOf(init).join(",")}}` : "";
          addExport({ name: d.name.text, line: line(d), kind: "variable", signature: norm(`${d.name.text}${d.type ? `: ${d.type.getText(sf)}` : ""}${shape}`), returnKeys: null }, d);
        }
      }
    }
  }

  // Dynamic import() and require() anywhere in the file.
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const isImport = n.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(n.expression) && n.expression.text === "require";
      if (isImport || isRequire) {
        const arg = n.arguments[0];
        if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) imports.push({ from: path, to: target(arg.text), spec: arg.text, names: [{ imported: "*", local: "" }], line: line(n), kind: isImport ? "dynamic-import" : "require" });
        else if (arg) gaps.push(`${path}:${line(n)} ${isImport ? "import()" : "require()"} with a computed path can't be followed`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);

  // Property reads on values returned by imported functions: `const v = f(...)` / `await f(...)`, then `v.prop`, or `const { a } = f()`.
  const importedLocal = new Map<string, string>(); // local name -> imported name
  for (const e of imports) if (e.kind === "import") for (const n of e.names) if (n.local && n.imported !== "*") importedLocal.set(n.local, n.imported);
  const uses: PropertyUse[] = [];
  const findUses = (scope: ts.Node) => {
    const bound = new Map<string, string>(); // variable -> imported symbol
    const walk = (n: ts.Node) => {
      if (ts.isVariableDeclaration(n) && n.initializer) {
        let e: ts.Expression = n.initializer;
        while (ts.isAwaitExpression(e) || ts.isParenthesizedExpression(e)) e = e.expression;
        if (ts.isCallExpression(e) && ts.isIdentifier(e.expression) && importedLocal.has(e.expression.text)) {
          const sym = importedLocal.get(e.expression.text)!;
          if (ts.isIdentifier(n.name)) bound.set(n.name.text, sym);
          else if (ts.isObjectBindingPattern(n.name)) for (const el of n.name.elements) uses.push({ symbol: sym, prop: (el.propertyName ?? el.name).getText(sf), line: line(el) });
        }
      }
      if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && bound.has(n.expression.text)) uses.push({ symbol: bound.get(n.expression.text)!, prop: n.name.text, line: line(n) });
      if (ts.isFunctionLike(n) && n !== scope) return findUses(n);
      ts.forEachChild(n, walk);
    };
    ts.forEachChild(scope, walk);
  };
  if (importedLocal.size) findUses(sf);

  return { path, hash: sha(text), imports, exports, uses, gaps };
}

/* ------------------------------------------------------------------------------------------------------------------ */

export interface InterfaceChange {
  file: string;
  symbol: string;
  change: "added" | "removed" | "signature" | "shape" | "implementation";
  before: string | null;
  after: string | null;
  removedKeys: string[];
  addedKeys: string[];
  line: number | null;
}

export interface Consumer {
  file: string;
  symbol: string;
  line: number;
  /** How the relationship was established. */
  evidence: { kind: "static-import" | "re-export" | "dynamic-import" | "require" | "namespace-import"; detail: string };
  /** Concrete breakages found by local data-flow (property read on a removed key). */
  breaks: { prop: string; line: number; reason: string }[];
  /** Property reads that still exist after the change, for context. */
  reads: string[];
}

export interface Impact {
  base: string;
  changedFiles: string[];
  interfaces: InterfaceChange[];
  consumers: Consumer[];
  tests: { file: string; chain: string[] }[];
  suggestions: string[];
  gaps: string[];
  stats: { files: number; parsed: number; cached: number; ms: number };
}

type Entry = { size: number; mtimeMs: number; info: ModuleInfo };

/**
 * The project graph. `refresh()` is incremental; `impact()` compares exports at a base revision against the workspace.
 * Base-revision content is supplied by the caller (so this module stays independent of git plumbing).
 */
export class DependencyGraph {
  private root: string;
  private entries = new Map<string, Entry>();
  private byHash = new Map<string, ModuleInfo>(); // content-addressed parse cache (also serves base revisions)
  private files = new Set<string>();
  private lastStats = { parsed: 0, cached: 0 };
  /** Bumped when the file set changes, since that can change how relative imports resolve. */
  private generation = 0;

  constructor(root: string) {
    this.root = root;
  }

  resolve = (from: string, spec: string): string | null => {
    const base = posix.normalize(posix.join(posix.dirname(from), spec));
    if (base.startsWith("..")) return null;
    const stem = base.replace(/\.(m|c)?js$/, "");
    const candidates = [base, ...CODE_EXT.map((e) => base + e), ...CODE_EXT.map((e) => stem + e), ...CODE_EXT.map((e) => `${base}/index${e}`)];
    return candidates.find((c) => this.files.has(c)) ?? null;
  };

  private parse(path: string, text: string): ModuleInfo {
    const h = sha(`${this.generation}\0${path}\0${text}`);
    const hit = this.byHash.get(h);
    if (hit) {
      this.lastStats.cached++;
      return hit;
    }
    this.lastStats.parsed++;
    const info = parseModule(path, text, this.resolve);
    if (this.byHash.size > 20_000) this.byHash.clear();
    this.byHash.set(h, info);
    return info;
  }

  /** Bring the graph up to date with `files` (repo-relative). Only files whose size or mtime changed are re-read. */
  refresh(files: string[]): { parsed: number; cached: number } {
    this.lastStats = { parsed: 0, cached: 0 };
    const code = files.filter(isCode);
    const prev = this.files;
    this.files = new Set(code);
    const setChanged = code.length !== prev.size || code.some((f) => !prev.has(f));
    if (setChanged) {
      this.generation++;
      this.byHash.clear();
    }
    for (const f of [...this.entries.keys()]) if (!this.files.has(f)) this.entries.delete(f);
    for (const f of code) {
      let st;
      try {
        st = statSync(join(this.root, f));
      } catch {
        continue;
      }
      const e = this.entries.get(f);
      if (e && e.size === st.size && e.mtimeMs === st.mtimeMs && !setChanged) continue;
      this.entries.set(f, { size: st.size, mtimeMs: st.mtimeMs, info: this.parse(f, readFileSync(join(this.root, f), "utf8")) });
    }
    return this.lastStats;
  }

  module(path: string): ModuleInfo | undefined {
    return this.entries.get(path)?.info;
  }
  modules(): ModuleInfo[] {
    return [...this.entries.values()].map((e) => e.info);
  }

  /** Files that import `file`, directly. */
  importersOf(file: string): ImportEdge[] {
    return this.modules().flatMap((m) => m.imports.filter((i) => i.to === file));
  }

  /** Test files that reach `file` through imports, with the shortest import chain. */
  testsReaching(files: string[]): { file: string; chain: string[] }[] {
    const reverse = new Map<string, string[]>();
    for (const m of this.modules()) for (const i of m.imports) if (i.to && !i.to.startsWith("pkg:")) reverse.set(i.to, [...(reverse.get(i.to) ?? []), m.path]);
    const out = new Map<string, string[]>();
    const queue: string[][] = files.map((f) => [f]);
    const seen = new Set(files);
    while (queue.length) {
      const chain = queue.shift()!;
      const at = chain.at(-1)!;
      if (isTestFile(at) && !out.has(at)) out.set(at, chain);
      for (const imp of reverse.get(at) ?? []) if (!seen.has(imp)) (seen.add(imp), queue.push([...chain, imp]));
    }
    return [...out.entries()].map(([file, chain]) => ({ file, chain: chain.reverse() }));
  }

  /**
   * What changed in exported interfaces between a base revision and the workspace, and what that affects.
   * `baseContent(path)` returns the file's text at the base revision, or null if it didn't exist there.
   */
  impact(base: string, changed: string[], baseContent: (path: string) => string | null): Impact {
    const t0 = performance.now();
    const interfaces: InterfaceChange[] = [];
    const gaps: string[] = [];
    for (const file of changed.filter(isCode)) {
      const now = this.module(file);
      const oldText = baseContent(file);
      const old = oldText === null ? null : this.parse(file, oldText);
      const before = new Map((old?.exports ?? []).map((e) => [e.name, e]));
      const after = new Map((now?.exports ?? []).map((e) => [e.name, e]));
      for (const [name, b] of before) {
        const a = after.get(name);
        if (!a) {
          interfaces.push({ file, symbol: name, change: "removed", before: b.signature, after: null, removedKeys: b.returnKeys ?? [], addedKeys: [], line: null });
          continue;
        }
        const removedKeys = (b.returnKeys ?? []).filter((k) => !(a.returnKeys ?? []).includes(k));
        const addedKeys = (a.returnKeys ?? []).filter((k) => !(b.returnKeys ?? []).includes(k));
        if (a.signature !== b.signature) interfaces.push({ file, symbol: name, change: "signature", before: b.signature, after: a.signature, removedKeys, addedKeys, line: a.line });
        else if (removedKeys.length || addedKeys.length) interfaces.push({ file, symbol: name, change: "shape", before: `returns {${(b.returnKeys ?? []).join(", ")}}`, after: `returns {${(a.returnKeys ?? []).join(", ")}}`, removedKeys, addedKeys, line: a.line });
        else if (a.bodyHash !== b.bodyHash) interfaces.push({ file, symbol: name, change: "implementation", before: null, after: null, removedKeys: [], addedKeys: [], line: a.line });
      }
      for (const [name, a] of after) if (!before.has(name)) interfaces.push({ file, symbol: name, change: "added", before: null, after: a.signature, removedKeys: [], addedKeys: [], line: a.line });
      gaps.push(...(now?.gaps ?? []));
    }

    // Consumers of every changed (non-added) symbol, following re-exports.
    const consumers: Consumer[] = [];
    const relevant = interfaces.filter((i) => i.change !== "added");
    const visited = new Set<string>();
    const follow = (file: string, symbol: string, change: InterfaceChange, via: string[]) => {
      const key = `${file}#${symbol}`;
      if (visited.has(key)) return;
      visited.add(key);
      for (const edge of this.importersOf(file)) {
        const m = this.module(edge.from)!;
        for (const n of edge.names) {
          const matches = n.imported === symbol || n.imported === "*";
          if (!matches) continue;
          if (edge.kind === "re-export") {
            follow(edge.from, n.local === "*" ? symbol : n.local, change, [...via, `${edge.from}:${edge.line}`]);
            continue;
          }
          const kind = n.imported === "*" ? (edge.kind === "import" ? "namespace-import" : edge.kind) : "static-import";
          const reads = m.uses.filter((u) => u.symbol === symbol);
          const breaks = reads.filter((u) => change.removedKeys.includes(u.prop)).map((u) => ({ prop: u.prop, line: u.line, reason: `reads .${u.prop}, which ${symbol}() no longer returns` }));
          if (n.imported === "*" && edge.kind !== "import") gaps.push(`${edge.from}:${edge.line} ${edge.kind} of ${file} can't be narrowed to specific symbols`);
          consumers.push({
            file: edge.from,
            symbol,
            line: edge.line,
            evidence: { kind, detail: `${edge.from}:${edge.line} ${edge.kind === "import" ? "imports" : edge.kind} ${n.imported === "*" ? "*" : `{ ${n.imported} }`} from '${edge.spec}'${via.length ? ` (via ${via.join(" → ")})` : ""}` },
            breaks,
            reads: [...new Set(reads.map((u) => u.prop))],
          });
        }
      }
    };
    for (const c of relevant) follow(c.file, c.symbol, c, []);

    const consumerFiles = [...new Set(consumers.map((c) => c.file))];
    const changedCode = [...new Set(relevant.map((i) => i.file))];
    const tests = this.testsReaching(changedCode);
    const suggestions: string[] = [];
    for (const c of consumers)
      for (const b of c.breaks) suggestions.push(`Update ${c.file}:${b.line}: it ${b.reason}${relevant.find((i) => i.symbol === c.symbol && i.addedKeys.length) ? ` (now returns ${relevant.find((i) => i.symbol === c.symbol)!.addedKeys.join(", ")})` : ""}.`);
    for (const i of relevant.filter((x) => x.change === "removed")) for (const c of consumers.filter((x) => x.symbol === i.symbol)) suggestions.push(`${c.file}:${c.line} imports ${i.symbol}, which ${i.file} no longer exports.`);
    for (const i of relevant.filter((x) => x.change === "signature")) {
      const n = consumers.filter((c) => c.symbol === i.symbol).length;
      if (n) suggestions.push(`${i.symbol} in ${i.file} changed from ${i.before} to ${i.after}; check its ${n} consumer${n > 1 ? "s" : ""}.`);
    }
    if (tests.length) suggestions.push(`Run the affected tests: ${tests.map((t) => t.file).join(", ")}.`);
    else if (relevant.length) gaps.push(`No test file imports ${changedCode.join(", ")} or its consumers; nothing covers this change statically.`);
    return { base, changedFiles: changed, interfaces, consumers, tests, suggestions, gaps: [...new Set(gaps)], stats: { files: this.entries.size, parsed: this.lastStats.parsed, cached: this.lastStats.cached, ms: Math.round(performance.now() - t0) } };
  }
}

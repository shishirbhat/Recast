import * as vscode from "vscode";
import type { FileSync } from "./fileSync.ts";

/**
 * Collaborators' carets and selections in VS Code editors, each in the member's own colour (the same colour the browser
 * IDE uses for their caret, avatar and line authorship), with their name next to the caret.
 */
export class PresenceDecorations implements vscode.Disposable {
  private carets = new Map<string, vscode.TextEditorDecorationType>();
  private selections = new Map<string, vscode.TextEditorDecorationType>();

  private caretType(color: string): vscode.TextEditorDecorationType {
    let t = this.carets.get(color);
    if (!t) {
      t = vscode.window.createTextEditorDecorationType({
        // A thin bar before the caret position, and a small name flag after it.
        before: { contentText: "", border: `solid ${color}`, width: "0", margin: "0 -1px 0 0", height: "1.1em", textDecoration: `none; border-width: 0 0 0 2px; position: relative; z-index: 1` },
        after: { color: "#ffffff", backgroundColor: color, margin: "0 0 0 2px", textDecoration: "none; font-size: 0.8em; padding: 0 3px; border-radius: 2px; vertical-align: top" },
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
      });
      this.carets.set(color, t);
    }
    return t;
  }

  private selectionType(color: string): vscode.TextEditorDecorationType {
    let t = this.selections.get(color);
    if (!t) {
      t = vscode.window.createTextEditorDecorationType({ backgroundColor: `${color}33`, rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed });
      this.selections.set(color, t);
    }
    return t;
  }

  /** Redraw collaborators in every visible editor showing `sync`'s document. */
  render(sync: FileSync): void {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document !== sync.document) continue;
      const carets = new Map<string, vscode.DecorationOptions[]>();
      const sels = new Map<string, vscode.Range[]>();
      for (const color of [...this.carets.keys()]) carets.set(color, []);
      for (const color of [...this.selections.keys()]) sels.set(color, []);
      for (const p of sync.peers()) {
        if (p.head === null) continue;
        const color = p.member.color;
        this.caretType(color);
        this.selectionType(color);
        const head = editor.document.positionAt(p.head);
        const list = carets.get(color) ?? [];
        list.push({ range: new vscode.Range(head, head), hoverMessage: `${p.member.name} (Relay)`, renderOptions: { after: { contentText: p.member.name } } });
        carets.set(color, list);
        if (p.anchor !== null && p.anchor !== p.head) {
          const a = editor.document.positionAt(p.anchor);
          const r = sels.get(color) ?? [];
          r.push(new vscode.Range(a.isBefore(head) ? a : head, a.isBefore(head) ? head : a));
          sels.set(color, r);
        }
      }
      for (const [color, opts] of carets) editor.setDecorations(this.caretType(color), opts);
      for (const [color, ranges] of sels) editor.setDecorations(this.selectionType(color), ranges);
    }
  }

  dispose(): void {
    for (const t of [...this.carets.values(), ...this.selections.values()]) t.dispose();
    this.carets.clear();
    this.selections.clear();
  }
}

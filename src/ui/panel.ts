import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { ReviewDocument } from "../review/report";
import { renderHtml } from "./html";
import { renderMarkdown } from "./markdown";

type PanelMessage =
  | { type: "open"; file: string; line: number }
  | { type: "exportHtml" }
  | { type: "exportMarkdown" }
  | { type: "rerun" };

/** A single reusable panel that shows the latest review. */
export class ReviewPanel {
  private static current: ReviewPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private doc: ReviewDocument;

  static show(doc: ReviewDocument, rerun: () => void): void {
    if (ReviewPanel.current) {
      ReviewPanel.current.update(doc);
      ReviewPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    ReviewPanel.current = new ReviewPanel(doc, rerun);
  }

  private constructor(doc: ReviewDocument, rerun: () => void) {
    this.doc = doc;
    this.panel = vscode.window.createWebviewPanel(
      "claudeCodeReview",
      "Code Review",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [],
      },
    );
    this.panel.onDidDispose(() => {
      ReviewPanel.current = undefined;
    });
    this.panel.webview.onDidReceiveMessage((message: PanelMessage) => {
      switch (message.type) {
        case "open":
          void this.openFile(message.file, message.line);
          break;
        case "exportHtml":
          void this.export("html");
          break;
        case "exportMarkdown":
          void this.export("md");
          break;
        case "rerun":
          rerun();
          break;
      }
    });
    this.update(doc);
  }

  private update(doc: ReviewDocument): void {
    this.doc = doc;
    this.panel.title = `Code Review: ${doc.repoName}`;
    this.panel.webview.html = renderHtml(doc, {
      kind: "webview",
      nonce: randomBytes(16).toString("base64"),
      cspSource: this.panel.webview.cspSource,
    });
  }

  private async openFile(file: string, line: number): Promise<void> {
    const absolute = path.resolve(this.doc.repositoryRoot, file);
    // The path comes from the webview, so only open files inside the repository.
    const relative = path.relative(this.doc.repositoryRoot, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return;
    }
    try {
      const position = new vscode.Position(Math.max(0, line - 1), 0);
      await vscode.window.showTextDocument(vscode.Uri.file(absolute), {
        viewColumn: vscode.ViewColumn.Beside,
        selection: new vscode.Range(position, position),
      });
    } catch {
      vscode.window.showWarningMessage(
        `Couldn't open ${file}. It may have been deleted.`,
      );
    }
  }

  private async export(format: "html" | "md"): Promise<void> {
    const stamp = this.doc.generatedAt
      .toISOString()
      .slice(0, 16)
      .replace(/[:T]/g, "-");
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(
        path.join(this.doc.repositoryRoot, `code-review-${stamp}.${format}`),
      ),
      filters:
        format === "html" ? { "HTML page": ["html"] } : { Markdown: ["md"] },
    });
    if (!target) {
      return;
    }
    const content =
      format === "html"
        ? renderHtml(this.doc, { kind: "standalone" })
        : renderMarkdown(this.doc);
    await vscode.workspace.fs.writeFile(target, Buffer.from(content, "utf8"));

    const action = format === "html" ? "Open in browser" : "Open preview";
    const choice = await vscode.window.showInformationMessage(
      `Saved ${path.basename(target.fsPath)}.`,
      action,
    );
    if (choice === "Open in browser") {
      await vscode.env.openExternal(target);
    } else if (choice === "Open preview") {
      await vscode.commands.executeCommand("markdown.showPreview", target);
    }
  }
}

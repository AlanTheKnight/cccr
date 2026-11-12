import * as vscode from "vscode";
import { ClaudeError, runClaude } from "./claude/runClaude";
import {
  GitError,
  collectGitChanges,
  hasChanges,
  type ReviewScope,
} from "./git/git";
import { SYSTEM_PROMPT, buildPrompt } from "./review/prompt";
import { buildDocument } from "./review/report";
import { REVIEW_JSON_SCHEMA, normalizeReview } from "./review/schema";
import { ReviewPanel } from "./ui/panel";

interface LastRun {
  folder: string;
  scope: ReviewScope;
}

let lastRun: LastRun | undefined;
let running = false;

/** The folder of the active editor, the only open folder, or one the user picks. */
async function pickFolder(): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  const activeFolder = activeUri
    ? vscode.workspace.getWorkspaceFolder(activeUri)
    : undefined;
  if (activeFolder) {
    return activeFolder.uri.fsPath;
  }
  if (folders.length === 0) {
    vscode.window.showErrorMessage(
      "Open a project folder before running a code review.",
    );
    return undefined;
  }
  if (folders.length === 1) {
    return folders[0]?.uri.fsPath;
  }
  const picked = await vscode.window.showWorkspaceFolderPick({
    placeHolder: "Which folder do you want reviewed?",
  });
  return picked?.uri.fsPath;
}

async function pickScope(): Promise<ReviewScope | undefined> {
  const items: Array<
    vscode.QuickPickItem & { scope?: ReviewScope; branch?: true }
  > = [
    {
      label: "$(git-commit) Uncommitted changes",
      description: "staged, unstaged and untracked",
      scope: { kind: "working" },
    },
    {
      label: "$(check) Staged changes",
      description: "what the next commit will contain",
      scope: { kind: "staged" },
    },
    {
      label: "$(history) Last commit",
      description: "HEAD",
      scope: { kind: "lastCommit" },
    },
    {
      label: "$(git-compare) Branch vs base…",
      description: "all commits since the base branch",
      branch: true,
    },
  ];
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: "What should Claude review?",
  });
  if (!picked) {
    return undefined;
  }
  if (picked.scope) {
    return picked.scope;
  }
  const base = await vscode.window.showInputBox({
    prompt: "Base branch or ref to compare against",
    value: vscode.workspace
      .getConfiguration("claudeCodeReview")
      .get<string>("defaultBaseBranch", "main"),
    validateInput: (v) => (v.trim() ? undefined : "Enter a branch or ref"),
  });
  return base ? { kind: "branch", base: base.trim() } : undefined;
}

async function review(
  folder: string,
  scope: ReviewScope,
  output: vscode.OutputChannel,
): Promise<void> {
  if (running) {
    vscode.window.showInformationMessage("A code review is already running.");
    return;
  }
  running = true;
  lastRun = { folder, scope };
  const config = vscode.workspace.getConfiguration("claudeCodeReview");

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Claude Code Review",
        cancellable: true,
      },
      async (progress, token) => {
        const abort = new AbortController();
        token.onCancellationRequested(() => abort.abort());

        progress.report({ message: "Collecting Git changes…" });
        output.appendLine(
          `\n[${new Date().toLocaleTimeString()}] Reviewing ${folder} (${scope.kind})`,
        );
        const changes = await collectGitChanges(folder, scope);
        if (!hasChanges(changes)) {
          vscode.window.showInformationMessage(
            `No changes found: ${changes.scopeLabel}.`,
          );
          return;
        }
        output.appendLine(
          `${changes.files.length} file(s), ${changes.untrackedFiles.length} untracked, ${changes.commits.length} commit(s)`,
        );

        const { prompt, truncated } = buildPrompt(changes);
        output.appendLine(
          `Prompt: ${prompt.length.toLocaleString()} characters${truncated ? " (truncated)" : ""}`,
        );

        progress.report({ message: "Claude is reviewing the changes…" });
        const result = await runClaude({
          claudePath: config.get<string>("claudePath", "claude") || "claude",
          cwd: changes.repositoryRoot,
          prompt,
          systemPrompt: SYSTEM_PROMPT,
          jsonSchema: REVIEW_JSON_SCHEMA,
          model: config.get<string>("model", "sonnet") || undefined,
          maxBudgetUsd: config.get<number>("maxBudgetUsd", 0),
          timeoutMs:
            Math.max(1, config.get<number>("timeoutMinutes", 15)) * 60_000,
          signal: abort.signal,
          onProgress: (message) => {
            output.appendLine(`  ${message}`);
            progress.report({ message });
          },
        });

        const doc = buildDocument(changes, normalizeReview(result.output), {
          models: result.models,
          costUsd: result.costUsd,
          durationMs: result.durationMs,
          promptTruncated: truncated,
        });
        output.appendLine(
          `Done: ${doc.review.findings.length} finding(s), verdict ${doc.review.verdict}, $${result.costUsd.toFixed(2)}, ${result.turns} turn(s)`,
        );
        ReviewPanel.show(doc, () => void review(folder, scope, output));
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(`Error: ${message}`);
    if (message === "Review cancelled.") {
      return;
    }
    const known = error instanceof GitError || error instanceof ClaudeError;
    const choice = await vscode.window.showErrorMessage(
      known ? message : `Code review failed: ${message}`,
      "Show log",
    );
    if (choice) {
      output.show(true);
    }
  } finally {
    running = false;
  }
}

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("Claude Code Review");
  context.subscriptions.push(output);

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeCodeReview.run", async () => {
      const folder = await pickFolder();
      if (!folder) {
        return;
      }
      const scope = await pickScope();
      if (scope) {
        await review(folder, scope, output);
      }
    }),
    vscode.commands.registerCommand("claudeCodeReview.rerun", async () => {
      if (lastRun) {
        await review(lastRun.folder, lastRun.scope, output);
      } else {
        await vscode.commands.executeCommand("claudeCodeReview.run");
      }
    }),
  );
}

export function deactivate() {}

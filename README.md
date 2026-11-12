# Claude Code Code Review (cccr)

A VS Code extension that reviews your Git changes with the [Claude Code](https://docs.claude.com/en/docs/claude-code) CLI and shows the result as a report inside the editor.

You pick what to review: uncommitted changes, staged changes, the last commit, or a branch compared with its base. The extension collects the diff, runs `claude -p` in the repository with read-only tools, and renders a report with a verdict, a risk score, findings ranked by severity, and suggested fixes.

## Requirements

- VS Code 1.90 or later
- Git on your `PATH`
- The [Claude Code CLI](https://docs.claude.com/en/docs/claude-code), installed and signed in
- [Bun](https://bun.sh) to build the extension from source

## Usage

1. Open a folder that is inside a Git repository.
2. Run **Claude Code Review: Review Git Changes** from the Command Palette, or press `Cmd+Shift+R` (`Ctrl+Shift+R` on Windows and Linux).
3. Choose a scope:

   | Scope | What gets reviewed |
   | --- | --- |
   | Uncommitted changes | Staged, unstaged and untracked files |
   | Staged changes | What the next commit will contain |
   | Last commit | `HEAD` compared with its parent |
   | Branch vs base… | Every commit since the merge base with the branch or ref you enter |

4. Wait for the review. A notification shows Claude's progress, such as which files it is reading, and you can cancel it there.

When the review finishes, the **Code Review** panel opens. It shows:

- a title, summary, verdict (approve, approve with comments, request changes, or block) and a risk score from 0 to 10
- an overview of the logical changes and a risk rating for each changed file
- findings sorted by severity, each with a category, a confidence level, an explanation, and a suggested fix (some include replacement code)
- what the change does well, and suggested tests

Click a file location in a finding to open that file at the line. From the panel you can also save the report as HTML or Markdown, or run the same review again. **Claude Code Review: Run Last Review Again** repeats the last review from the Command Palette.

The **Claude Code Review** output channel logs each run: the number of files, the prompt size, Claude's tool calls, the cost and the number of turns.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `claudeCodeReview.claudePath` | `claude` | Path to the Claude Code CLI. With the default, the extension looks on `PATH` and in the usual install locations. |
| `claudeCodeReview.model` | `sonnet` | Model for reviews, such as `sonnet` or `opus`. Leave empty to use your Claude Code default model. |
| `claudeCodeReview.maxBudgetUsd` | `0` | Stop a review once it has spent this many US dollars. `0` means no limit. |
| `claudeCodeReview.timeoutMinutes` | `15` | Give up on a review after this many minutes. |
| `claudeCodeReview.defaultBaseBranch` | `main` | Branch suggested when you review a branch against its base. |

## How it works

1. **Collect changes** ([src/git/git.ts](src/git/git.ts)). The extension runs `git diff` and `git log` for the chosen scope. For uncommitted changes it also reads untracked files, skipping symlinks, binary files, files over 100 KB, and anything past the first 100 files. A diff larger than 10 MB is rejected.
2. **Build the prompt** ([src/review/prompt.ts](src/review/prompt.ts)). The diff, commit list and untracked file contents go into one prompt, cut off at 400,000 characters. When the prompt is cut off, Claude is told to read the remaining files itself, and the report says so.
3. **Run Claude Code** ([src/claude/runClaude.ts](src/claude/runClaude.ts)). The extension starts `claude -p` in the repository root with only the `Read`, `Grep` and `Glob` tools, so Claude can look at surrounding code but cannot change files. `--json-schema` makes Claude return a structured review, and `--no-session-persistence` keeps the run out of your Claude Code history.
4. **Render the report** ([src/review/schema.ts](src/review/schema.ts), [src/ui/](src/ui/)). The output is normalized against the schema so a missing field never breaks rendering, then shown in a webview panel or exported as HTML or Markdown.

## Development

```bash
bun install
bun run compile   # build into out/
bun run watch     # rebuild on change
bun run check     # type-check only
```

To try the extension, open this folder in VS Code and press `F5`. The **Run Extension** launch configuration opens a new VS Code window with the extension loaded from `out/`.

To build an installable package:

```bash
bun run package   # compiles, then runs vsce package
```

Install the resulting `.vsix` with **Extensions: Install from VSIX…** in VS Code.

### Project layout

```
src/
  extension.ts          commands, folder and scope pickers, review flow
  git/git.ts            collects diffs, stats, commits and untracked files
  review/prompt.ts      system prompt and review prompt
  review/schema.ts      review JSON schema and output normalization
  review/report.ts      report data, stats and labels
  claude/runClaude.ts   runs the Claude Code CLI and streams its progress
  ui/panel.ts           webview panel, file links and export
  ui/html.ts            HTML rendering (webview and standalone)
  ui/markdown.ts        Markdown rendering
```

If you change the review format, update both the `ReviewResult` type and `REVIEW_JSON_SCHEMA` in [src/review/schema.ts](src/review/schema.ts). The schema is what Claude Code receives, so the two must stay in sync.

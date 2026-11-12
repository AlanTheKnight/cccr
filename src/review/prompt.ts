import type { GitChangeSet } from "../git/git";

/** Keeps the prompt well inside the model's context window. */
const MAX_PROMPT_DIFF_CHARS = 400_000;

export const SYSTEM_PROMPT = `You are a senior engineer doing a thorough code review of a Git change set.
You are running inside the repository. Use Read, Grep and Glob to look at surrounding code,
callers and tests whenever the diff alone isn't enough to judge a change. Do not modify anything.

Review for, in order of importance:
1. Bugs: logic errors, wrong conditions, off-by-one, null/undefined handling, broken contracts with callers.
2. Security: injection, path traversal, secrets in code, unsafe deserialization, missing auth checks.
3. Error handling and concurrency: swallowed errors, unhandled promise rejections, races.
4. Performance problems that matter at realistic scale.
5. Maintainability, missing tests, and style — only when worth a reviewer's time.

Rules for findings:
- Every finding must be about code in the diff (or code the diff breaks). Name the concrete scenario where it fails.
- "line" is the 1-based line number in the NEW version of the file. Read the file to confirm it. Use 0 only if the finding isn't tied to a line.
- Don't report a finding you can't support from the code; lower "confidence" when you're unsure.
- No duplicates. Don't pad the list: an empty findings array is fine for a clean change.
- Severity: critical = data loss, security hole or crash in a main path; high = wrong behaviour users will hit;
  medium = edge-case bug or notable risk; low = minor issue; info = observation.
- Verdict: "block" if any critical finding; "request_changes" if any high; otherwise "approve_with_comments"
  or "approve".

List every changed file in fileSummaries. Write plain text; you may use \`backticks\` for code identifiers.`;

export interface BuiltPrompt {
  prompt: string;
  truncated: boolean;
}

export function buildPrompt(changes: GitChangeSet): BuiltPrompt {
  const parts: string[] = [
    `Review this change set.`,
    ``,
    `Repository: ${changes.repositoryRoot}`,
    `Branch: ${changes.branch}${changes.head ? ` @ ${changes.head}` : ""}`,
    `Scope: ${changes.scopeLabel}`,
  ];

  if (changes.commits.length > 0) {
    parts.push(
      "",
      "Commits:",
      ...changes.commits.map((c) => `- ${c.hash} ${c.subject} (${c.author})`),
    );
  }

  for (const section of changes.sections) {
    if (section.diff.trim()) {
      parts.push("", `===== ${section.title} =====`, section.diff);
    }
  }

  if (changes.untrackedFiles.length > 0) {
    parts.push("", "===== New untracked files (full content) =====");
    for (const file of changes.untrackedFiles) {
      parts.push(`--- ${file.path} ---`, file.content);
    }
  }

  if (changes.skipped.length > 0) {
    parts.push(
      "",
      "Files not included above (you may Read them if relevant):",
      ...changes.skipped.map((s) => `- ${s.path} (${s.reason})`),
    );
  }

  let prompt = parts.join("\n");
  let truncated = false;
  if (prompt.length > MAX_PROMPT_DIFF_CHARS) {
    prompt =
      prompt.slice(0, MAX_PROMPT_DIFF_CHARS) +
      "\n\n[The diff was truncated here because it is too large. Use Read and Grep on the changed files to review the rest.]";
    truncated = true;
  }
  return { prompt, truncated };
}

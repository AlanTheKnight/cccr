import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

export interface ClaudeRunOptions {
  claudePath: string;
  cwd: string;
  prompt: string;
  systemPrompt: string;
  jsonSchema: object;
  model?: string;
  maxBudgetUsd?: number;
  timeoutMs: number;
  /** Called with short status lines such as "Reading src/foo.ts". */
  onProgress?: (message: string) => void;
  /** Aborting kills the Claude process. */
  signal?: AbortSignal;
}

export interface ClaudeRunResult {
  output: unknown;
  costUsd: number;
  durationMs: number;
  turns: number;
  models: string[];
}

export class ClaudeError extends Error {}

/**
 * VS Code started from the Dock doesn't inherit the shell's PATH, so the
 * usual install locations of the Claude Code CLI are added explicitly.
 */
function augmentedPath(): string {
  const home = os.homedir();
  const extra = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(home, ".local", "bin"),
    path.join(home, ".claude", "local"),
    path.join(home, ".npm-global", "bin"),
  ];
  const current = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean);
  return [...current, ...extra.filter((p) => !current.includes(p))].join(
    path.delimiter,
  );
}

function describeToolUse(
  name: string,
  input: Record<string, unknown>,
  cwd: string,
): string {
  const rel = (p: unknown) =>
    typeof p === "string"
      ? path.isAbsolute(p)
        ? path.relative(cwd, p) || p
        : p
      : "";
  switch (name) {
    case "Read":
      return `Reading ${rel(input.file_path)}`;
    case "Grep":
      return `Searching for "${String(input.pattern ?? "")}"`;
    case "Glob":
      return `Listing ${String(input.pattern ?? "files")}`;
    case "StructuredOutput":
      return "Writing the report";
    default:
      return `Using ${name}`;
  }
}

export function runClaude(options: ClaudeRunOptions): Promise<ClaudeRunResult> {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    // Read-only: Claude can inspect the repository but not change it.
    "--tools",
    "Read,Grep,Glob",
    "--allowedTools",
    "Read,Grep,Glob",
    "--permission-mode",
    "dontAsk",
    "--append-system-prompt",
    options.systemPrompt,
    "--json-schema",
    JSON.stringify(options.jsonSchema),
  ];
  if (options.model) {
    args.push("--model", options.model);
  }
  if (options.maxBudgetUsd && options.maxBudgetUsd > 0) {
    args.push("--max-budget-usd", String(options.maxBudgetUsd));
  }

  return new Promise((resolve, reject) => {
    const child = spawn(options.claudePath, args, {
      cwd: options.cwd,
      env: { ...process.env, PATH: augmentedPath() },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let settled = false;
    let stdoutBuffer = "";
    let stderr = "";
    let result: Record<string, unknown> | undefined;

    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      fn();
    };

    const timer = setTimeout(() => {
      child.kill();
      finish(() =>
        reject(
          new ClaudeError(
            `Claude Code didn't finish within ${Math.round(options.timeoutMs / 60000)} minutes.`,
          ),
        ),
      );
    }, options.timeoutMs);

    const onAbort = () => {
      child.kill();
      finish(() => reject(new ClaudeError("Review cancelled.")));
    };
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener("abort", onAbort);

    const handleLine = (line: string) => {
      if (!line.trim()) {
        return;
      }
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      if (event.type === "assistant") {
        const message = event.message as
          { content?: Array<Record<string, unknown>> } | undefined;
        for (const block of message?.content ?? []) {
          if (block.type === "tool_use") {
            options.onProgress?.(
              describeToolUse(
                String(block.name),
                (block.input ?? {}) as Record<string, unknown>,
                options.cwd,
              ),
            );
          }
        }
      } else if (event.type === "result") {
        result = event;
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      let newline: number;
      while ((newline = stdoutBuffer.indexOf("\n")) !== -1) {
        handleLine(stdoutBuffer.slice(0, newline));
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      finish(() =>
        reject(
          error.code === "ENOENT"
            ? new ClaudeError(
                `Couldn't find the Claude Code CLI ("${options.claudePath}"). Install it or set "claudeCodeReview.claudePath".`,
              )
            : new ClaudeError(error.message),
        ),
      );
    });

    child.on("close", (code) => {
      handleLine(stdoutBuffer);
      finish(() => {
        if (!result) {
          reject(
            new ClaudeError(
              `Claude Code exited with code ${code} without a result.${stderr.trim() ? `\n${stderr.trim()}` : ""}`,
            ),
          );
          return;
        }
        if (result.is_error || result.subtype !== "success") {
          const reason =
            typeof result.result === "string" && result.result
              ? result.result
              : String(result.subtype ?? "unknown error");
          reject(new ClaudeError(`Claude Code failed: ${reason}`));
          return;
        }
        if (result.structured_output === undefined) {
          reject(new ClaudeError("Claude Code returned no structured review."));
          return;
        }
        resolve({
          output: result.structured_output,
          costUsd: Number(result.total_cost_usd ?? 0),
          durationMs: Number(result.duration_ms ?? 0),
          turns: Number(result.num_turns ?? 0),
          models: Object.keys((result.modelUsage as object | undefined) ?? {}),
        });
      });
    });

    child.stdin.on("error", () => {
      // The process exited before reading stdin; the close handler reports it.
    });
    child.stdin.end(options.prompt);
  });
}

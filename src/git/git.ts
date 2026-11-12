import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);

const MAX_DIFF_BUFFER = 10 * 1024 * 1024;
const MAX_UNTRACKED_FILE_SIZE = 100 * 1024;
const MAX_UNTRACKED_FILES = 100;
const MAX_COMMITS = 50;

/** Git's well-known empty tree, used as the base for a root commit. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export type ReviewScope =
  | { kind: "working" }
  | { kind: "staged" }
  | { kind: "lastCommit" }
  | { kind: "branch"; base: string };

export interface FileStat {
  path: string;
  /** null for binary files. */
  additions: number | null;
  deletions: number | null;
  untracked: boolean;
}

export interface CommitInfo {
  hash: string;
  author: string;
  date: string;
  subject: string;
}

export interface SkippedFile {
  path: string;
  reason: string;
}

export interface GitChangeSet {
  repositoryRoot: string;
  branch: string;
  head: string;
  scopeLabel: string;
  /** Diff sections, each with a heading, in review order. */
  sections: Array<{ title: string; diff: string }>;
  untrackedFiles: Array<{ path: string; content: string }>;
  files: FileStat[];
  commits: CommitInfo[];
  skipped: SkippedFile[];
}

export class GitError extends Error {}

async function runGit(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: MAX_DIFF_BUFFER,
      windowsHide: true,
    });
    return stdout;
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string };
    if (err.code === "ENOENT") {
      throw new GitError("Git is not installed or not on PATH.");
    }
    if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      throw new GitError(
        `The diff is larger than ${MAX_DIFF_BUFFER / 1024 / 1024} MB. Review a smaller scope.`,
      );
    }
    const stderr = (err.stderr ?? "").trim();
    if (/not a git repository/i.test(stderr)) {
      throw new GitError("This folder isn't inside a Git repository.");
    }
    throw new GitError(stderr || err.message);
  }
}

async function tryGit(cwd: string, args: string[]): Promise<string | null> {
  try {
    return await runGit(cwd, args);
  } catch {
    return null;
  }
}

function isInsideDirectory(directory: string, target: string): boolean {
  const relative = path.relative(directory, target);

  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

async function collectUntrackedFiles(repositoryRoot: string): Promise<{
  files: GitChangeSet["untrackedFiles"];
  stats: FileStat[];
  skipped: SkippedFile[];
}> {
  const output = await runGit(repositoryRoot, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]);

  const allPaths = output.split("\0").filter(Boolean);
  const files: GitChangeSet["untrackedFiles"] = [];
  const stats: FileStat[] = [];
  const skipped: SkippedFile[] = allPaths
    .slice(MAX_UNTRACKED_FILES)
    .map((p) => ({
      path: p,
      reason: `over the ${MAX_UNTRACKED_FILES}-file limit`,
    }));

  for (const relativePath of allPaths.slice(0, MAX_UNTRACKED_FILES)) {
    const absolutePath = path.resolve(repositoryRoot, relativePath);

    // Never read a path outside the repository.
    if (!isInsideDirectory(repositoryRoot, absolutePath)) {
      continue;
    }

    try {
      const info = await lstat(absolutePath);

      if (info.isSymbolicLink()) {
        skipped.push({ path: relativePath, reason: "symlink" });
        continue;
      }
      if (!info.isFile()) {
        continue;
      }
      if (info.size > MAX_UNTRACKED_FILE_SIZE) {
        skipped.push({
          path: relativePath,
          reason: `larger than ${MAX_UNTRACKED_FILE_SIZE / 1024} KB`,
        });
        stats.push({
          path: relativePath,
          additions: null,
          deletions: null,
          untracked: true,
        });
        continue;
      }

      const buffer = await readFile(absolutePath);

      // Skip likely binary files.
      if (buffer.includes(0)) {
        skipped.push({ path: relativePath, reason: "binary" });
        stats.push({
          path: relativePath,
          additions: null,
          deletions: null,
          untracked: true,
        });
        continue;
      }

      const content = buffer.toString("utf8");
      const lines =
        content === ""
          ? 0
          : content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
      files.push({ path: relativePath, content });
      stats.push({
        path: relativePath,
        additions: lines,
        deletions: 0,
        untracked: true,
      });
    } catch {
      // Ignore files that disappear or become unreadable during collection.
      continue;
    }
  }

  return { files, stats, skipped };
}

/** Parses `git diff --numstat -z --no-renames` output. */
function parseNumstat(output: string): FileStat[] {
  return output
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const [add = "-", del = "-", ...rest] = record.split("\t");
      return {
        path: rest.join("\t"),
        additions: add === "-" ? null : Number(add),
        deletions: del === "-" ? null : Number(del),
        untracked: false,
      };
    })
    .filter((s) => s.path !== "");
}

function diffArgs(...extra: string[]): string[] {
  return ["diff", "--no-ext-diff", "--unified=3", ...extra];
}

function numstatArgs(...extra: string[]): string[] {
  return ["diff", "--no-ext-diff", "--numstat", "-z", "--no-renames", ...extra];
}

async function collectCommits(
  repositoryRoot: string,
  range: string,
): Promise<CommitInfo[]> {
  const output = await runGit(repositoryRoot, [
    "log",
    `--max-count=${MAX_COMMITS}`,
    "--format=%h%x1f%an%x1f%aI%x1f%s%x1e",
    range,
  ]);
  return output
    .split("\x1e")
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [hash = "", author = "", date = "", subject = ""] = r.split("\x1f");
      return { hash, author, date, subject };
    });
}

export async function collectGitChanges(
  workspacePath: string,
  scope: ReviewScope = { kind: "working" },
): Promise<GitChangeSet> {
  const repositoryRoot = (
    await runGit(workspacePath, ["rev-parse", "--show-toplevel"])
  ).trim();

  const branch =
    (
      await tryGit(repositoryRoot, ["rev-parse", "--abbrev-ref", "HEAD"])
    )?.trim() ?? "(no branch)";
  const head =
    (await tryGit(repositoryRoot, ["rev-parse", "--short", "HEAD"]))?.trim() ??
    "";
  const hasHead = head !== "";

  const base: Omit<GitChangeSet, "scopeLabel" | "sections" | "files"> = {
    repositoryRoot,
    branch,
    head,
    untrackedFiles: [],
    commits: [],
    skipped: [],
  };

  switch (scope.kind) {
    case "working": {
      const [stagedDiff, unstagedDiff, untracked, numstat] = await Promise.all([
        runGit(repositoryRoot, diffArgs("--cached")),
        runGit(repositoryRoot, diffArgs()),
        collectUntrackedFiles(repositoryRoot),
        // Against HEAD this counts each line once even if it is both staged and unstaged.
        hasHead
          ? runGit(repositoryRoot, numstatArgs("HEAD"))
          : runGit(repositoryRoot, numstatArgs("--cached")),
      ]);
      return {
        ...base,
        scopeLabel: "Uncommitted changes (staged, unstaged and untracked)",
        sections: [
          { title: "Staged changes", diff: stagedDiff },
          { title: "Unstaged changes", diff: unstagedDiff },
        ],
        untrackedFiles: untracked.files,
        files: [...parseNumstat(numstat), ...untracked.stats],
        skipped: untracked.skipped,
      };
    }

    case "staged": {
      const [stagedDiff, numstat] = await Promise.all([
        runGit(repositoryRoot, diffArgs("--cached")),
        runGit(repositoryRoot, numstatArgs("--cached")),
      ]);
      return {
        ...base,
        scopeLabel: "Staged changes",
        sections: [{ title: "Staged changes", diff: stagedDiff }],
        files: parseNumstat(numstat),
      };
    }

    case "lastCommit": {
      if (!hasHead) {
        throw new GitError("This repository has no commits yet.");
      }
      const parent = (
        await tryGit(repositoryRoot, [
          "rev-parse",
          "--verify",
          "--quiet",
          "HEAD~1",
        ])
      )?.trim();
      const from = parent || EMPTY_TREE;
      const [diff, numstat, commits] = await Promise.all([
        runGit(repositoryRoot, diffArgs(from, "HEAD")),
        runGit(repositoryRoot, numstatArgs(from, "HEAD")),
        collectCommits(repositoryRoot, "-1"),
      ]);
      return {
        ...base,
        scopeLabel: `Last commit (${head})`,
        sections: [{ title: `Commit ${head}`, diff }],
        files: parseNumstat(numstat),
        commits,
      };
    }

    case "branch": {
      if (!hasHead) {
        throw new GitError("This repository has no commits yet.");
      }
      const mergeBase = (
        await tryGit(repositoryRoot, ["merge-base", scope.base, "HEAD"])
      )?.trim();
      if (!mergeBase) {
        throw new GitError(
          `Couldn't find a common ancestor of "${scope.base}" and HEAD.`,
        );
      }
      const [diff, numstat, commits] = await Promise.all([
        runGit(repositoryRoot, diffArgs(mergeBase, "HEAD")),
        runGit(repositoryRoot, numstatArgs(mergeBase, "HEAD")),
        collectCommits(repositoryRoot, `${mergeBase}..HEAD`),
      ]);
      return {
        ...base,
        scopeLabel: `${branch} compared with ${scope.base}`,
        sections: [{ title: `Commits on ${branch} since ${scope.base}`, diff }],
        files: parseNumstat(numstat),
        commits,
      };
    }
  }
}

export function hasChanges(changes: GitChangeSet): boolean {
  return (
    changes.sections.some((s) => s.diff.length > 0) ||
    changes.untrackedFiles.length > 0 ||
    changes.files.length > 0
  );
}

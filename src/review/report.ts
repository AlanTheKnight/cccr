import path from "node:path";
import type {
  CommitInfo,
  FileStat,
  GitChangeSet,
  SkippedFile,
} from "../git/git";
import {
  CATEGORIES,
  SEVERITIES,
  type Category,
  type ReviewResult,
  type Severity,
} from "./schema";

/** Everything a renderer needs: git facts (measured) plus Claude's review (judged). */
export interface ReviewDocument {
  repoName: string;
  repositoryRoot: string;
  branch: string;
  head: string;
  scopeLabel: string;
  generatedAt: Date;
  models: string[];
  costUsd: number;
  durationMs: number;
  promptTruncated: boolean;
  files: FileStat[];
  commits: CommitInfo[];
  skipped: SkippedFile[];
  review: ReviewResult;
}

export function buildDocument(
  changes: GitChangeSet,
  review: ReviewResult,
  run: {
    models: string[];
    costUsd: number;
    durationMs: number;
    promptTruncated: boolean;
  },
): ReviewDocument {
  return {
    repoName: path.basename(changes.repositoryRoot),
    repositoryRoot: changes.repositoryRoot,
    branch: changes.branch,
    head: changes.head,
    scopeLabel: changes.scopeLabel,
    generatedAt: new Date(),
    models: run.models,
    costUsd: run.costUsd,
    durationMs: run.durationMs,
    promptTruncated: run.promptTruncated,
    files: changes.files,
    commits: changes.commits,
    skipped: changes.skipped,
    review,
  };
}

export interface ReportStats {
  totalAdditions: number;
  totalDeletions: number;
  bySeverity: Record<Severity, number>;
  byCategory: Array<{ category: Category; count: number }>;
}

export function computeStats(doc: ReviewDocument): ReportStats {
  const bySeverity = Object.fromEntries(
    SEVERITIES.map((s) => [s, 0]),
  ) as Record<Severity, number>;
  const categoryCounts = new Map<Category, number>();
  for (const f of doc.review.findings) {
    bySeverity[f.severity] += 1;
    categoryCounts.set(f.category, (categoryCounts.get(f.category) ?? 0) + 1);
  }
  return {
    totalAdditions: doc.files.reduce((n, f) => n + (f.additions ?? 0), 0),
    totalDeletions: doc.files.reduce((n, f) => n + (f.deletions ?? 0), 0),
    bySeverity,
    byCategory: CATEGORIES.map((category) => ({
      category,
      count: categoryCounts.get(category) ?? 0,
    }))
      .filter((c) => c.count > 0)
      .sort((a, b) => b.count - a.count),
  };
}

export const VERDICT_LABELS = {
  approve: "Approve",
  approve_with_comments: "Approve with comments",
  request_changes: "Changes requested",
  block: "Blocked",
} as const;

export const CATEGORY_LABELS: Record<Category, string> = {
  bug: "Bug",
  security: "Security",
  performance: "Performance",
  "error-handling": "Error handling",
  concurrency: "Concurrency",
  maintainability: "Maintainability",
  testing: "Testing",
  style: "Style",
};

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function fileLink(
  doc: ReviewDocument,
  file: string,
  line: number,
): string {
  const abs = path.resolve(doc.repositoryRoot, file);
  return `vscode://file${encodeURI(abs)}${line > 0 ? `:${line}` : ""}`;
}

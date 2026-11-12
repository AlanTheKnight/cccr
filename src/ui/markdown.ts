import {
  CATEGORY_LABELS,
  VERDICT_LABELS,
  computeStats,
  fileLink,
  formatDuration,
  type ReviewDocument,
} from "../review/report";
import { SEVERITIES, type Severity } from "../review/schema";

const SEVERITY_ICONS: Record<Severity, string> = {
  critical: "🔴",
  high: "🟠",
  medium: "🟡",
  low: "🔵",
  info: "⚪",
};

const SEVERITY_ALERTS: Record<Severity, string> = {
  critical: "CAUTION",
  high: "CAUTION",
  medium: "WARNING",
  low: "NOTE",
  info: "NOTE",
};

const VERDICT_ALERTS = {
  approve: "TIP",
  approve_with_comments: "NOTE",
  request_changes: "WARNING",
  block: "CAUTION",
} as const;

/** Markdown table cells can't contain pipes or newlines. */
function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** Prefixes every line so multi-line text stays inside a blockquote alert. */
function quote(value: string): string {
  return value
    .split("\n")
    .map((l) => (l ? `> ${l}` : ">"))
    .join("\n");
}

/** Mermaid labels are quoted strings; strip characters that would break them. */
function mermaidLabel(value: string): string {
  return value.replace(/["\n]/g, "");
}

function fence(code: string): string {
  // Use a fence longer than any backtick run in the code.
  const longest = Math.max(
    2,
    ...(code.match(/`+/g) ?? []).map((m) => m.length),
  );
  const ticks = "`".repeat(longest + 1);
  return `${ticks}\n${code.replace(/\n$/, "")}\n${ticks}`;
}

export function renderMarkdown(doc: ReviewDocument): string {
  const { review } = doc;
  const stats = computeStats(doc);
  const out: string[] = [];

  out.push(`# Code review: ${review.title}`, "");
  out.push(
    `**Repository** \`${doc.repoName}\` · **Branch** \`${doc.branch}\`${doc.head ? ` @ \`${doc.head}\`` : ""} · ${doc.scopeLabel} · ${doc.generatedAt.toLocaleString()}`,
    "",
  );

  out.push(
    quote(
      `[!${VERDICT_ALERTS[review.verdict]}]\n**${VERDICT_LABELS[review.verdict]}**\n\n${review.summary}`,
    ),
    "",
  );

  out.push(
    "| Risk score | Files changed | Lines | Findings | Critical / high |",
    "|:---:|:---:|:---:|:---:|:---:|",
    `| **${review.riskScore}/10** | ${doc.files.length} | +${stats.totalAdditions} / −${stats.totalDeletions} | ${review.findings.length} | ${stats.bySeverity.critical + stats.bySeverity.high} |`,
    "",
  );
  if (review.riskRationale) {
    out.push(`_${review.riskRationale}_`, "");
  }

  if (review.findings.length > 0) {
    out.push(
      "```mermaid",
      "pie showData title Findings by severity",
      ...SEVERITIES.filter((s) => stats.bySeverity[s] > 0).map(
        (s) => `    "${s}" : ${stats.bySeverity[s]}`,
      ),
      "```",
      "",
    );
    out.push(
      "```mermaid",
      "pie showData title Findings by category",
      ...stats.byCategory.map(
        (c) =>
          `    "${mermaidLabel(CATEGORY_LABELS[c.category])}" : ${c.count}`,
      ),
      "```",
      "",
    );
  }

  const churn = doc.files
    .filter(
      (f) =>
        f.additions !== null && (f.additions ?? 0) + (f.deletions ?? 0) > 0,
    )
    .sort(
      (a, b) =>
        (b.additions ?? 0) +
        (b.deletions ?? 0) -
        ((a.additions ?? 0) + (a.deletions ?? 0)),
    )
    .slice(0, 12);
  if (churn.length > 1) {
    out.push(
      "```mermaid",
      "xychart-beta",
      '    title "Lines changed per file"',
      `    x-axis [${churn.map((f) => `"${mermaidLabel(f.path.split("/").pop() ?? f.path)}"`).join(", ")}]`,
      '    y-axis "Lines"',
      `    bar [${churn.map((f) => (f.additions ?? 0) + (f.deletions ?? 0)).join(", ")}]`,
      "```",
      "",
    );
  }

  if (review.changeOverview.length > 0) {
    out.push("## What changed", "");
    for (const c of review.changeOverview) {
      out.push(`- **${c.title}**: ${c.description.replace(/\n+/g, " ")}`);
    }
    out.push("");
  }

  out.push(`## Findings (${review.findings.length})`, "");
  if (review.findings.length === 0) {
    out.push(quote("[!TIP]\nNo issues found in this change set."), "");
  }
  review.findings.forEach((f, i) => {
    const where = f.file
      ? `[\`${f.file}${f.line > 0 ? `:${f.line}` : ""}\`](${fileLink(doc, f.file, f.line)})`
      : "";
    const body = [
      `[!${SEVERITY_ALERTS[f.severity]}]`,
      `**${SEVERITY_ICONS[f.severity]} ${f.severity.toUpperCase()} · ${CATEGORY_LABELS[f.category]}${f.confidence !== "high" ? ` · ${f.confidence} confidence` : ""}**${where ? ` — ${where}` : ""}`,
      "",
      f.description,
    ];
    if (f.suggestion) {
      body.push("", `**Suggested fix:** ${f.suggestion}`);
    }
    if (f.suggestedCode.trim()) {
      body.push("", fence(f.suggestedCode));
    }
    out.push(`### ${i + 1}. ${f.title}`, "", quote(body.join("\n")), "");
  });

  const summaries = new Map(review.fileSummaries.map((s) => [s.path, s]));
  const paths = [
    ...new Set([...doc.files.map((f) => f.path), ...summaries.keys()]),
  ];
  const stat = new Map(doc.files.map((f) => [f.path, f]));
  out.push(
    `## Files (${paths.length})`,
    "",
    "| File | Lines | Risk | Summary |",
    "|---|---:|:---:|---|",
  );
  for (const p of paths) {
    const s = stat.get(p);
    const summary = summaries.get(p);
    const lines = !s
      ? ""
      : s.additions === null
        ? "binary"
        : `+${s.additions} / −${s.deletions}`;
    out.push(
      `| \`${cell(p)}\`${s?.untracked ? " (new)" : ""} | ${lines} | ${summary?.risk ?? ""} | ${cell(summary?.summary ?? "")} |`,
    );
  }
  out.push("");

  if (review.positives.length > 0) {
    out.push(
      "## What's done well",
      "",
      ...review.positives.map((p) => `- ${p}`),
      "",
    );
  }
  if (review.testingRecommendations.length > 0) {
    out.push(
      "## Testing recommendations",
      "",
      ...review.testingRecommendations.map((t) => `- [ ] ${t}`),
      "",
    );
  }

  if (doc.commits.length > 0) {
    out.push(
      "## Commits",
      "",
      "| Commit | Subject | Author | Date |",
      "|---|---|---|---|",
    );
    for (const c of doc.commits) {
      out.push(
        `| \`${c.hash}\` | ${cell(c.subject)} | ${cell(c.author)} | ${c.date.slice(0, 10)} |`,
      );
    }
    out.push("");
  }

  const notes: string[] = [];
  if (doc.promptTruncated) {
    notes.push(
      "The diff was too large to send in full; Claude reviewed the rest by reading the changed files.",
    );
  }
  if (doc.skipped.length > 0) {
    notes.push(
      `Not sent with the diff: ${doc.skipped.map((s) => `\`${s.path}\` (${s.reason})`).join(", ")}`,
    );
  }
  if (notes.length > 0) {
    out.push(
      quote(
        [
          "[!WARNING]",
          "**Coverage notes**",
          "",
          ...notes.map((n) => `- ${n}`),
        ].join("\n"),
      ),
      "",
    );
  }

  out.push(
    "---",
    `_Generated by Claude Code${doc.models.length ? ` (${doc.models.join(", ")})` : ""} in ${formatDuration(doc.durationMs)}${doc.costUsd > 0 ? `, $${doc.costUsd.toFixed(2)}` : ""}. AI findings can be wrong; verify before acting on them._`,
    "",
  );

  return out.join("\n");
}

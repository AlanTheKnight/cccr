/**
 * The structured review Claude Code returns. The JSON schema below is passed
 * to `claude -p --json-schema`, so the two must stay in sync.
 */

export const SEVERITIES = [
  "critical",
  "high",
  "medium",
  "low",
  "info",
] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CATEGORIES = [
  "bug",
  "security",
  "performance",
  "error-handling",
  "concurrency",
  "maintainability",
  "testing",
  "style",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const VERDICTS = [
  "approve",
  "approve_with_comments",
  "request_changes",
  "block",
] as const;
export type Verdict = (typeof VERDICTS)[number];

export type Risk = "low" | "medium" | "high";
export type Confidence = "high" | "medium" | "low";

export interface Finding {
  severity: Severity;
  category: Category;
  confidence: Confidence;
  title: string;
  file: string;
  /** 1-based line in the new version of the file; 0 when not tied to a line. */
  line: number;
  description: string;
  suggestion: string;
  /** Replacement code, or "" when there is none. */
  suggestedCode: string;
}

export interface ReviewResult {
  title: string;
  summary: string;
  verdict: Verdict;
  riskScore: number;
  riskRationale: string;
  changeOverview: Array<{ title: string; description: string }>;
  fileSummaries: Array<{ path: string; risk: Risk; summary: string }>;
  findings: Finding[];
  positives: string[];
  testingRecommendations: string[];
}

const str = { type: "string" };

export const REVIEW_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "title",
    "summary",
    "verdict",
    "riskScore",
    "riskRationale",
    "changeOverview",
    "fileSummaries",
    "findings",
    "positives",
    "testingRecommendations",
  ],
  properties: {
    title: {
      type: "string",
      description: "Short title for the change set, like a PR title",
    },
    summary: {
      type: "string",
      description:
        "2-4 sentences: what the change does and the overall assessment",
    },
    verdict: { type: "string", enum: VERDICTS },
    riskScore: {
      type: "integer",
      minimum: 0,
      maximum: 10,
      description: "0 = trivial, 10 = very likely to break production",
    },
    riskRationale: { type: "string" },
    changeOverview: {
      type: "array",
      description:
        "The logical changes in this diff, grouped by intent rather than by file",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "description"],
        properties: { title: str, description: str },
      },
    },
    fileSummaries: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "risk", "summary"],
        properties: {
          path: {
            type: "string",
            description: "Repository-relative path, exactly as in the diff",
          },
          risk: { type: "string", enum: ["low", "medium", "high"] },
          summary: str,
        },
      },
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "severity",
          "category",
          "confidence",
          "title",
          "file",
          "line",
          "description",
          "suggestion",
          "suggestedCode",
        ],
        properties: {
          severity: { type: "string", enum: SEVERITIES },
          category: { type: "string", enum: CATEGORIES },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
          title: str,
          file: { type: "string", description: "Repository-relative path" },
          line: {
            type: "integer",
            minimum: 0,
            description:
              "1-based line in the NEW file version; 0 if not line-specific",
          },
          description: {
            type: "string",
            description:
              "What is wrong and the concrete scenario where it fails",
          },
          suggestion: { type: "string", description: "How to fix it" },
          suggestedCode: {
            type: "string",
            description: "Replacement code snippet, or empty string",
          },
        },
      },
    },
    positives: {
      type: "array",
      items: str,
      description: "Things the change does well",
    },
    testingRecommendations: { type: "array", items: str },
  },
} as const;

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function list<T>(
  value: unknown,
  map: (item: Record<string, unknown>) => T,
): T[] {
  return Array.isArray(value)
    ? value
        .filter(
          (v): v is Record<string, unknown> =>
            typeof v === "object" && v !== null,
        )
        .map(map)
    : [];
}

/** Coerces Claude's output into a ReviewResult so rendering never crashes on a missing field. */
export function normalizeReview(raw: unknown): ReviewResult {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<
    string,
    unknown
  >;
  const score = Number(r.riskScore);
  return {
    title: text(r.title) || "Code review",
    summary: text(r.summary),
    verdict: oneOf(r.verdict, VERDICTS, "approve_with_comments"),
    riskScore: Number.isFinite(score)
      ? Math.min(10, Math.max(0, Math.round(score)))
      : 0,
    riskRationale: text(r.riskRationale),
    changeOverview: list(r.changeOverview, (c) => ({
      title: text(c.title),
      description: text(c.description),
    })),
    fileSummaries: list(r.fileSummaries, (f) => ({
      path: text(f.path),
      risk: oneOf(f.risk, ["low", "medium", "high"] as const, "low"),
      summary: text(f.summary),
    })),
    findings: list(r.findings, (f) => ({
      severity: oneOf(f.severity, SEVERITIES, "info"),
      category: oneOf(f.category, CATEGORIES, "maintainability"),
      confidence: oneOf(
        f.confidence,
        ["high", "medium", "low"] as const,
        "medium",
      ),
      title: text(f.title),
      file: text(f.file),
      line:
        Number.isInteger(f.line) && (f.line as number) > 0
          ? (f.line as number)
          : 0,
      description: text(f.description),
      suggestion: text(f.suggestion),
      suggestedCode: text(f.suggestedCode),
    })).sort(
      (a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity),
    ),
    positives: Array.isArray(r.positives)
      ? r.positives.map(text).filter(Boolean)
      : [],
    testingRecommendations: Array.isArray(r.testingRecommendations)
      ? r.testingRecommendations.map(text).filter(Boolean)
      : [],
  };
}

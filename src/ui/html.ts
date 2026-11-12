import {
  CATEGORY_LABELS,
  VERDICT_LABELS,
  computeStats,
  fileLink,
  formatDuration,
  type ReviewDocument,
} from "../review/report";
import { SEVERITIES, type Finding, type Severity } from "../review/schema";

export type HtmlMode =
  | { kind: "standalone" }
  | { kind: "webview"; nonce: string; cspSource: string };

function esc(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Escapes, then renders the small subset of markdown Claude uses: `code` and **bold**. */
function inline(value: string): string {
  return esc(value)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
}

function paragraphs(value: string): string {
  return value
    .split(/\n{2,}/)
    .filter((p) => p.trim())
    .map((p) => `<p>${inline(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

const SEVERITY_LABELS: Record<Severity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
  info: "Info",
};

/* ---------------------------------------------------------------- charts */

const CHART_WIDTH = 520;
const ROW_HEIGHT = 26;
const LABEL_WIDTH = 150;
const VALUE_WIDTH = 44;

function barChart(
  title: string,
  rows: Array<{ label: string; value: number; className: string }>,
): string {
  if (rows.length === 0) {
    return "";
  }
  const max = Math.max(1, ...rows.map((r) => r.value));
  const plot = CHART_WIDTH - LABEL_WIDTH - VALUE_WIDTH;
  const height = rows.length * ROW_HEIGHT;
  const bars = rows
    .map((r, i) => {
      const y = i * ROW_HEIGHT;
      const w = r.value === 0 ? 0 : Math.max(3, (r.value / max) * plot);
      return `
      <text class="chart-label" x="${LABEL_WIDTH - 10}" y="${y + ROW_HEIGHT / 2}" text-anchor="end" dominant-baseline="central">${esc(r.label)}</text>
      <rect class="chart-track" x="${LABEL_WIDTH}" y="${y + 6}" width="${plot}" height="${ROW_HEIGHT - 12}" rx="3"/>
      <rect class="${r.className}" x="${LABEL_WIDTH}" y="${y + 6}" width="${w.toFixed(1)}" height="${ROW_HEIGHT - 12}" rx="3"><title>${esc(r.label)}: ${r.value}</title></rect>
      <text class="chart-value" x="${CHART_WIDTH - VALUE_WIDTH + 8}" y="${y + ROW_HEIGHT / 2}" dominant-baseline="central">${r.value}</text>`;
    })
    .join("");
  return `
  <figure class="card chart">
    <figcaption>${esc(title)}</figcaption>
    <svg viewBox="0 0 ${CHART_WIDTH} ${height}" role="img" aria-label="${esc(title)}">${bars}</svg>
  </figure>`;
}

function shortenPath(p: string, max = 22): string {
  if (p.length <= max) {
    return p;
  }
  const name = p.split("/").pop() ?? p;
  return name.length + 2 <= max ? `…/${name}` : `…${name.slice(-(max - 1))}`;
}

function churnChart(doc: ReviewDocument): string {
  const files = doc.files
    .filter((f) => f.additions !== null)
    .map((f) => ({ ...f, total: (f.additions ?? 0) + (f.deletions ?? 0) }))
    .filter((f) => f.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, 15);
  if (files.length === 0) {
    return "";
  }
  const max = Math.max(...files.map((f) => f.total));
  const labelWidth = 190;
  const valueWidth = 90;
  const plot = CHART_WIDTH + 120 - labelWidth - valueWidth;
  const width = CHART_WIDTH + 120;
  const rows = files
    .map((f, i) => {
      const y = i * ROW_HEIGHT;
      const add = ((f.additions ?? 0) / max) * plot;
      const del = ((f.deletions ?? 0) / max) * plot;
      return `
      <text class="chart-label mono" x="${labelWidth - 10}" y="${y + ROW_HEIGHT / 2}" text-anchor="end" dominant-baseline="central"><title>${esc(f.path)}</title>${esc(shortenPath(f.path))}</text>
      <rect class="bar-add" x="${labelWidth}" y="${y + 6}" width="${add.toFixed(1)}" height="${ROW_HEIGHT - 12}"><title>${esc(f.path)}: +${f.additions}</title></rect>
      <rect class="bar-del" x="${(labelWidth + add + (add > 0 && del > 0 ? 2 : 0)).toFixed(1)}" y="${y + 6}" width="${del.toFixed(1)}" height="${ROW_HEIGHT - 12}"><title>${esc(f.path)}: −${f.deletions}</title></rect>
      <text class="chart-value" x="${width - valueWidth + 8}" y="${y + ROW_HEIGHT / 2}" dominant-baseline="central"><tspan class="add-text">+${f.additions}</tspan> <tspan class="del-text">−${f.deletions}</tspan></text>`;
    })
    .join("");
  return `
  <figure class="card chart wide">
    <figcaption>Lines changed per file${doc.files.length > files.length ? ` (top ${files.length})` : ""}
      <span class="legend"><i class="sw bar-add"></i>added <i class="sw bar-del"></i>removed</span></figcaption>
    <svg viewBox="0 0 ${width} ${files.length * ROW_HEIGHT}" role="img" aria-label="Lines changed per file">${rows}</svg>
  </figure>`;
}

function riskGauge(score: number): string {
  // Semicircle gauge, 0 on the left, 10 on the right.
  const r = 52;
  const cx = 64;
  const cy = 62;
  const angle = Math.PI * (1 - score / 10);
  const x = cx + r * Math.cos(angle);
  const y = cy - r * Math.sin(angle);
  const level = score >= 7 ? "high" : score >= 4 ? "medium" : "low";
  const arc =
    score === 0
      ? ""
      : `<path class="gauge-fill risk-${level}" d="M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)}"/>`;
  return `<svg class="gauge" viewBox="0 0 128 72" role="img" aria-label="Risk ${score} of 10">
    <path class="gauge-track" d="M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}"/>${arc}
    <text class="gauge-value" x="${cx}" y="${cy - 6}" text-anchor="middle">${score}</text>
    <text class="gauge-sub" x="${cx}" y="${cy + 8}" text-anchor="middle">of 10</text>
  </svg>`;
}

/* ---------------------------------------------------------------- sections */

function location(
  doc: ReviewDocument,
  mode: HtmlMode,
  file: string,
  line: number,
): string {
  if (!file) {
    return "";
  }
  const label = `${file}${line > 0 ? `:${line}` : ""}`;
  const href = mode.kind === "webview" ? "#" : fileLink(doc, file, line);
  return `<a class="loc mono" href="${esc(href)}" data-file="${esc(file)}" data-line="${line}">${esc(label)}</a>`;
}

function verdictAlert(doc: ReviewDocument): string {
  const { verdict, summary } = doc.review;
  const tone = {
    approve: "success",
    approve_with_comments: "note",
    request_changes: "warning",
    block: "danger",
  }[verdict];
  return `
  <div class="alert alert-${tone} verdict">
    <div class="alert-title">${esc(VERDICT_LABELS[verdict])}</div>
    ${paragraphs(summary)}
  </div>`;
}

function kpis(doc: ReviewDocument): string {
  const stats = computeStats(doc);
  const serious = stats.bySeverity.critical + stats.bySeverity.high;
  const tile = (label: string, value: string, sub = "") =>
    `<div class="card kpi"><div class="kpi-label">${esc(label)}</div><div class="kpi-value">${value}</div>${sub ? `<div class="kpi-sub">${sub}</div>` : ""}</div>`;
  return `
  <section class="kpis">
    <div class="card kpi risk">
      <div class="kpi-label">Risk score</div>
      ${riskGauge(doc.review.riskScore)}
    </div>
    ${tile("Files changed", String(doc.files.length))}
    ${tile("Lines", `<span class="add-text">+${stats.totalAdditions}</span> <span class="del-text">−${stats.totalDeletions}</span>`)}
    ${tile(
      "Findings",
      String(doc.review.findings.length),
      serious > 0
        ? `<span class="sev-text-high">${serious} critical or high</span>`
        : "none critical or high",
    )}
    ${doc.commits.length > 0 ? tile("Commits", String(doc.commits.length)) : ""}
  </section>`;
}

function charts(doc: ReviewDocument): string {
  const stats = computeStats(doc);
  const severity = doc.review.findings.length
    ? barChart(
        "Findings by severity",
        SEVERITIES.map((s) => ({
          label: SEVERITY_LABELS[s],
          value: stats.bySeverity[s],
          className: `bar-${s}`,
        })),
      )
    : "";
  const category = barChart(
    "Findings by category",
    stats.byCategory.map((c) => ({
      label: CATEGORY_LABELS[c.category],
      value: c.count,
      className: "bar-accent",
    })),
  );
  return `<section class="charts">${severity}${category}${churnChart(doc)}</section>`;
}

function findingCard(
  doc: ReviewDocument,
  mode: HtmlMode,
  f: Finding,
  index: number,
): string {
  const open =
    f.severity === "critical" || f.severity === "high" ? " open" : "";
  return `
  <details class="finding sev-${f.severity}"${open} id="finding-${index + 1}">
    <summary>
      <span class="pill pill-${f.severity}">${SEVERITY_LABELS[f.severity]}</span>
      <span class="finding-title">${inline(f.title)}</span>
      <span class="tag">${esc(CATEGORY_LABELS[f.category])}</span>
      ${f.confidence !== "high" ? `<span class="tag muted">${esc(f.confidence)} confidence</span>` : ""}
    </summary>
    <div class="finding-body">
      ${location(doc, mode, f.file, f.line)}
      ${paragraphs(f.description)}
      ${f.suggestion ? `<div class="suggestion"><strong>Suggested fix:</strong> ${inline(f.suggestion)}</div>` : ""}
      ${f.suggestedCode.trim() ? `<pre class="code"><code>${esc(f.suggestedCode)}</code></pre>` : ""}
    </div>
  </details>`;
}

function findingsSection(doc: ReviewDocument, mode: HtmlMode): string {
  const { findings } = doc.review;
  if (findings.length === 0) {
    return `
    <section>
      <h2>Findings</h2>
      <div class="alert alert-success"><div class="alert-title">No issues found</div><p>Claude didn't find any problems worth reporting in this change set.</p></div>
    </section>`;
  }
  return `
  <section>
    <h2>Findings <span class="count">${findings.length}</span></h2>
    ${findings.map((f, i) => findingCard(doc, mode, f, i)).join("")}
  </section>`;
}

function overviewSection(doc: ReviewDocument): string {
  if (doc.review.changeOverview.length === 0) {
    return "";
  }
  return `
  <section>
    <h2>What changed</h2>
    <div class="overview">
      ${doc.review.changeOverview
        .map(
          (c) =>
            `<div class="card"><h3>${inline(c.title)}</h3>${paragraphs(c.description)}</div>`,
        )
        .join("")}
    </div>
  </section>`;
}

function filesSection(doc: ReviewDocument, mode: HtmlMode): string {
  const summaries = new Map(doc.review.fileSummaries.map((s) => [s.path, s]));
  const findingCounts = new Map<string, number>();
  for (const f of doc.review.findings) {
    findingCounts.set(f.file, (findingCounts.get(f.file) ?? 0) + 1);
  }
  const paths = [
    ...new Set([...doc.files.map((f) => f.path), ...summaries.keys()]),
  ];
  const stat = new Map(doc.files.map((f) => [f.path, f]));
  const rows = paths
    .map((p) => {
      const s = stat.get(p);
      const summary = summaries.get(p);
      const lines = !s
        ? ""
        : s.additions === null
          ? `<span class="muted">binary</span>`
          : `<span class="add-text">+${s.additions}</span> <span class="del-text">−${s.deletions}</span>`;
      return `<tr>
        <td>${location(doc, mode, p, 0)}${s?.untracked ? ` <span class="tag">new</span>` : ""}</td>
        <td class="num">${lines}</td>
        <td>${summary ? `<span class="pill pill-risk-${summary.risk}">${summary.risk}</span>` : ""}</td>
        <td class="num">${findingCounts.get(p) ?? ""}</td>
        <td>${summary ? inline(summary.summary) : ""}</td>
      </tr>`;
    })
    .join("");
  return `
  <section>
    <h2>Files <span class="count">${paths.length}</span></h2>
    <div class="table-wrap"><table>
      <thead><tr><th>File</th><th class="num">Lines</th><th>Risk</th><th class="num">Findings</th><th>Summary</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </section>`;
}

function listAlert(tone: string, title: string, items: string[]): string {
  if (items.length === 0) {
    return "";
  }
  return `<div class="alert alert-${tone}"><div class="alert-title">${esc(title)}</div><ul>${items
    .map((i) => `<li>${inline(i)}</li>`)
    .join("")}</ul></div>`;
}

function commitsSection(doc: ReviewDocument): string {
  if (doc.commits.length === 0) {
    return "";
  }
  return `
  <section>
    <h2>Commits <span class="count">${doc.commits.length}</span></h2>
    <div class="table-wrap"><table>
      <thead><tr><th>Commit</th><th>Subject</th><th>Author</th><th>Date</th></tr></thead>
      <tbody>${doc.commits
        .map(
          (c) =>
            `<tr><td class="mono">${esc(c.hash)}</td><td>${esc(c.subject)}</td><td>${esc(c.author)}</td><td class="nowrap">${esc(c.date.slice(0, 10))}</td></tr>`,
        )
        .join("")}</tbody>
    </table></div>
  </section>`;
}

function notesSection(doc: ReviewDocument): string {
  const notes: string[] = [];
  if (doc.promptTruncated) {
    notes.push(
      "The diff was too large to send in full. Claude reviewed the rest by reading the changed files, so coverage of the tail may be thinner.",
    );
  }
  if (doc.skipped.length > 0) {
    notes.push(
      `${doc.skipped.length} untracked file(s) weren't sent with the diff: ` +
        doc.skipped
          .slice(0, 10)
          .map((s) => `\`${s.path}\` (${s.reason})`)
          .join(", ") +
        (doc.skipped.length > 10 ? ", …" : ""),
    );
  }
  return listAlert("warning", "Coverage notes", notes);
}

/* ---------------------------------------------------------------- page */

const STYLES = `
:root {
  --bg: #f6f7f9; --surface: #ffffff; --fg: #1f2328; --fg-muted: #59636e; --border: #d8dee4; --track: #eef1f4;
  --accent: #3b6fd8; --code-bg: #f1f3f5;
  --critical: #c21d2c; --high: #d4580f; --medium: #b07d00; --low: #2f6fd0; --info: #6e7781;
  --add: #1a7f37; --del: #cf222e;
  --success-bg: #e9f6ec; --success-bd: #1a7f37; --note-bg: #eaf1fd; --note-bd: #2f6fd0;
  --warning-bg: #fdf5e1; --warning-bd: #b07d00; --danger-bg: #fdecec; --danger-bd: #c21d2c;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #0f1216; --surface: #171b21; --fg: #e6e9ed; --fg-muted: #9aa4af; --border: #2c333c; --track: #232a32;
    --accent: #6d9cf5; --code-bg: #10141a;
    --critical: #ff6b73; --high: #ff9a4d; --medium: #e3b341; --low: #6d9cf5; --info: #8b949e;
    --add: #3fb950; --del: #ff7b72;
    --success-bg: #13261a; --note-bg: #142035; --warning-bg: #2a2410; --danger-bg: #2d1416;
    --success-bd: #3fb950; --note-bd: #6d9cf5; --warning-bd: #e3b341; --danger-bd: #ff6b73;
  }
}
:root[data-theme="dark"], body.vscode-dark, body.vscode-high-contrast {
  --bg: #0f1216; --surface: #171b21; --fg: #e6e9ed; --fg-muted: #9aa4af; --border: #2c333c; --track: #232a32;
  --accent: #6d9cf5; --code-bg: #10141a;
  --critical: #ff6b73; --high: #ff9a4d; --medium: #e3b341; --low: #6d9cf5; --info: #8b949e;
  --add: #3fb950; --del: #ff7b72;
  --success-bg: #13261a; --note-bg: #142035; --warning-bg: #2a2410; --danger-bg: #2d1416;
  --success-bd: #3fb950; --note-bd: #6d9cf5; --warning-bd: #e3b341; --danger-bd: #ff6b73;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
main { max-width: 1100px; margin: 0 auto; padding: 32px 16px 48px; }
h1 { font-size: 26px; line-height: 1.25; margin: 4px 0 6px; }
h2 { font-size: 18px; margin: 36px 0 12px; display: flex; align-items: center; gap: 8px; }
h3 { font-size: 15px; margin: 0 0 6px; }
p { margin: 0 0 8px; } p:last-child { margin-bottom: 0; }
a { color: var(--accent); }
code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; }
:not(pre) > code { background: var(--code-bg); padding: 1px 5px; border-radius: 4px; }
.muted { color: var(--fg-muted); }
.eyebrow { color: var(--fg-muted); font-size: 12px; text-transform: uppercase; letter-spacing: .06em; }
.meta { color: var(--fg-muted); display: flex; flex-wrap: wrap; gap: 4px 16px; margin-bottom: 20px; }
.header-row { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
button { font: inherit; padding: 6px 12px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface); color: var(--fg); cursor: pointer; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
button:hover { filter: brightness(1.08); }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; }
.count { font-size: 12px; font-weight: 600; color: var(--fg-muted); background: var(--track); border-radius: 999px; padding: 1px 8px; }

.alert { border: 1px solid var(--border); border-left-width: 4px; border-radius: 8px; padding: 12px 16px; margin: 12px 0; }
.alert-title { font-weight: 650; margin-bottom: 4px; }
.alert ul { margin: 4px 0 0; padding-left: 20px; }
.alert-success { background: var(--success-bg); border-left-color: var(--success-bd); }
.alert-note { background: var(--note-bg); border-left-color: var(--note-bd); }
.alert-warning { background: var(--warning-bg); border-left-color: var(--warning-bd); }
.alert-danger { background: var(--danger-bg); border-left-color: var(--danger-bd); }
.verdict .alert-title { font-size: 16px; }

.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-top: 16px; }
.kpi-label { color: var(--fg-muted); font-size: 12px; }
.kpi-value { font-size: 26px; font-weight: 650; margin-top: 4px; font-variant-numeric: tabular-nums; }
.kpi-sub { color: var(--fg-muted); font-size: 12px; }
.gauge { width: 128px; display: block; margin-top: 2px; }
.gauge-track, .gauge-fill { fill: none; stroke-width: 10; stroke-linecap: round; }
.gauge-track { stroke: var(--track); }
.gauge-fill.risk-low { stroke: var(--add); } .gauge-fill.risk-medium { stroke: var(--medium); } .gauge-fill.risk-high { stroke: var(--critical); }
.gauge-value { fill: var(--fg); font-size: 22px; font-weight: 700; }
.gauge-sub { fill: var(--fg-muted); font-size: 10px; }

.charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 12px; margin-top: 12px; }
.chart { margin: 0; } .chart.wide { grid-column: 1 / -1; }
.chart figcaption { font-weight: 600; margin-bottom: 10px; display: flex; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.chart svg { width: 100%; height: auto; display: block; }
.chart-label { fill: var(--fg-muted); font-size: 12px; }
.chart-label.mono { font-size: 11.5px; }
.chart-value { fill: var(--fg); font-size: 12px; font-variant-numeric: tabular-nums; }
.chart-track { fill: var(--track); }
.legend { font-weight: 400; color: var(--fg-muted); font-size: 12px; display: inline-flex; align-items: center; gap: 6px; }
.sw { display: inline-block; width: 10px; height: 10px; border-radius: 2px; }
.bar-critical { fill: var(--critical); } .bar-high { fill: var(--high); } .bar-medium { fill: var(--medium); }
.bar-low { fill: var(--low); } .bar-info { fill: var(--info); } .bar-accent { fill: var(--accent); }
.bar-add { fill: var(--add); background: var(--add); } .bar-del { fill: var(--del); background: var(--del); }
.add-text { color: var(--add); fill: var(--add); } .del-text { color: var(--del); fill: var(--del); }
.sev-text-high { color: var(--high); }

.overview { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }

.finding { background: var(--surface); border: 1px solid var(--border); border-left: 4px solid var(--info); border-radius: 8px; margin: 10px 0; }
.finding.sev-critical { border-left-color: var(--critical); } .finding.sev-high { border-left-color: var(--high); }
.finding.sev-medium { border-left-color: var(--medium); } .finding.sev-low { border-left-color: var(--low); }
.finding summary { cursor: pointer; padding: 10px 14px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; list-style: none; }
.finding summary::-webkit-details-marker { display: none; }
.finding summary::before { content: "▸"; color: var(--fg-muted); transition: transform .15s; }
.finding[open] summary::before { transform: rotate(90deg); }
.finding-title { font-weight: 600; flex: 1 1 240px; }
.finding-body { padding: 0 14px 14px 30px; }
.finding-body .loc { display: inline-block; margin-bottom: 8px; }
.suggestion { margin-top: 10px; }
pre.code { background: var(--code-bg); border: 1px solid var(--border); border-radius: 6px; padding: 10px 12px; overflow-x: auto; margin: 10px 0 0; }

.pill { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; padding: 2px 8px; border-radius: 999px; color: #fff; white-space: nowrap; }
.pill-critical { background: var(--critical); } .pill-high { background: var(--high); } .pill-medium { background: var(--medium); }
.pill-low { background: var(--low); } .pill-info { background: var(--info); }
.pill-risk-low { background: var(--add); } .pill-risk-medium { background: var(--medium); } .pill-risk-high { background: var(--critical); }
body.vscode-dark .pill, body.vscode-high-contrast .pill { color: #0f1216; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .pill { color: #0f1216; } }
.tag { font-size: 11.5px; color: var(--fg-muted); border: 1px solid var(--border); border-radius: 999px; padding: 1px 8px; white-space: nowrap; }

.table-wrap { overflow-x: auto; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
tr:last-child td { border-bottom: 0; }
th { font-size: 12px; color: var(--fg-muted); font-weight: 600; }
.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.nowrap { white-space: nowrap; }
footer { margin-top: 40px; color: var(--fg-muted); font-size: 12px; border-top: 1px solid var(--border); padding-top: 12px; }
`;

const WEBVIEW_SCRIPT = `
const vscode = acquireVsCodeApi();
document.addEventListener("click", (e) => {
  const link = e.target.closest("a.loc");
  if (link) {
    e.preventDefault();
    vscode.postMessage({ type: "open", file: link.dataset.file, line: Number(link.dataset.line) });
    return;
  }
  const button = e.target.closest("button[data-action]");
  if (button) {
    vscode.postMessage({ type: button.dataset.action });
  }
});
`;

export function renderHtml(doc: ReviewDocument, mode: HtmlMode): string {
  const { review } = doc;
  const csp =
    mode.kind === "webview"
      ? `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${mode.nonce}'; img-src ${mode.cspSource} data:;">`
      : "";
  const actions =
    mode.kind === "webview"
      ? `<div class="actions">
          <button data-action="exportHtml" class="primary">Save as HTML</button>
          <button data-action="exportMarkdown">Save as Markdown</button>
          <button data-action="rerun">Run again</button>
        </div>`
      : "";
  const script =
    mode.kind === "webview"
      ? `<script nonce="${mode.nonce}">${WEBVIEW_SCRIPT}</script>`
      : "";
  const generated = doc.generatedAt.toLocaleString();

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${csp}
<title>Code review: ${esc(review.title)}</title>
<style>${STYLES}</style>
</head>
<body>
<main>
  <div class="header-row">
    <div>
      <div class="eyebrow">Code review · ${esc(doc.repoName)}</div>
      <h1>${inline(review.title)}</h1>
    </div>
    ${actions}
  </div>
  <div class="meta">
    <span>Branch <code>${esc(doc.branch)}</code>${doc.head ? ` @ <code>${esc(doc.head)}</code>` : ""}</span>
    <span>${esc(doc.scopeLabel)}</span>
    <span>${esc(generated)}</span>
  </div>

  ${verdictAlert(doc)}
  ${kpis(doc)}
  ${review.riskRationale ? `<p class="muted" style="margin-top:10px">${inline(review.riskRationale)}</p>` : ""}
  ${charts(doc)}
  ${overviewSection(doc)}
  ${findingsSection(doc, mode)}
  ${filesSection(doc, mode)}
  ${
    review.positives.length || review.testingRecommendations.length
      ? `<section><h2>Recommendations</h2>
    ${listAlert("success", "What's done well", review.positives)}
    ${listAlert("note", "Testing recommendations", review.testingRecommendations)}
  </section>`
      : ""
  }
  ${commitsSection(doc)}
  ${notesSection(doc)}

  <footer>
    Generated by Claude Code${doc.models.length ? ` (${esc(doc.models.join(", "))})` : ""}
    · ${esc(formatDuration(doc.durationMs))}
    ${doc.costUsd > 0 ? ` · $${doc.costUsd.toFixed(2)}` : ""}
    · AI findings can be wrong; verify before acting on them.
  </footer>
</main>
${script}
</body>
</html>`;
}

#!/usr/bin/env node
// Scores Jev against shadcn-ui/lint's own RuleTester cases.
//
// Usage: TYPESAFE_API_KEY=... node run-rule-cases.mjs <cases.jsonl> --repo <shadcn-lint checkout> [--out dir] [--limit n]
//
// cases.jsonl comes from the rule tests run with DUMP_CASES (see README).
// Each case is linted with the real rule to get the actual diagnostics.
// Then one request per case asks `case.is_violation` (label: valid/invalid),
// and one request per real finding asks `finding.message_actionable`.
import * as fs from "node:fs"
import { execFileSync } from "node:child_process"
import { createRequire } from "node:module"
import * as path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i !== -1 ? args[i + 1] : fallback
}
const casesPath = args[0]
const REPO = flag("repo") && path.resolve(flag("repo"))
const OUT = flag("out", path.join(here, "results", `rule-cases-${new Date().toISOString().replace(/[:.]/g, "-")}`))
const LIMIT = Number(flag("limit", Infinity))
const KEY = process.env.TYPESAFE_API_KEY
if (!casesPath || !REPO || !KEY) {
  console.error("Usage: TYPESAFE_API_KEY=... node run-rule-cases.mjs <cases.jsonl> --repo <checkout>")
  process.exit(1)
}

const lintPkg = path.join(REPO, "packages/lint")
const req = createRequire(path.join(lintPkg, "package.json"))
const { Linter } = req("eslint")
const parser = req("@typescript-eslint/parser")
const { plugin } = await import(pathToFileURL(path.join(lintPkg, "dist/index.js")).href)

const RULES = JSON.parse(fs.readFileSync(path.join(here, "rules.json"), "utf-8")).rules
const QUESTIONS = JSON.parse(fs.readFileSync(path.join(here, "questions.json"), "utf-8"))
// RuleTester lints cases without a filename as a file in its cwd.
const fallbackFile = path.join(lintPkg, "file.tsx")

// design-system.json is the source of truth for what Jev is told about
// each project. Regenerate it with extract-design-system.mjs.
const DESIGN = JSON.parse(fs.readFileSync(path.join(here, "design-system.json"), "utf-8"))
const head = execFileSync("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim()
if (head !== DESIGN.commit)
  console.warn(`design-system.json is from ${DESIGN.commit.slice(0, 7)}, the checkout is at ${head.slice(0, 7)}`)

function designSystem(filename) {
  const fixture = Object.keys(DESIGN.projects).find((k) => filename?.startsWith(`${k}/`))
  return fixture ? { fixture, ...DESIGN.projects[fixture] } : { note: DESIGN.outside }
}

function lint(c) {
  // Case filenames are relative to the checkout, except deliberately
  // nonexistent absolute ones.
  const filename = c.filename ? path.resolve(REPO, c.filename) : fallbackFile
  const inside = filename.startsWith(REPO + path.sep)
  const linter = new Linter({ cwd: inside ? REPO : path.parse(filename).root })
  const messages = linter.verify(
    c.code,
    [
      {
        files: ["**/*.tsx", "**/*.jsx", "**/*.ts", "**/*.js"],
        languageOptions: { parser, parserOptions: { ecmaFeatures: { jsx: true } } },
        plugins: { shadcn: plugin },
        settings: c.settings ?? {},
        rules: { [`shadcn/${c.rule}`]: ["error", ...(c.options ?? [])] },
      },
    ],
    filename
  )
  if (messages.some((m) => !m.ruleId && !m.fatal)) throw new Error(messages[0].message)
  return messages.map((m) => ({ line: m.line, column: m.column, rule: m.ruleId, message: m.message, fatal: !!m.fatal }))
}

async function ask(state, questions, attempt = 0) {
  const res = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: QUESTIONS.model, state, questions }),
  })
  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt))
    return ask(state, questions, attempt + 1)
  }
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(body).slice(0, 300)}`)
  return body
}

async function pool(items, size, fn) {
  const out = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i], i)
      }
    })
  )
  return out
}

const numbered = (code) =>
  code.split("\n").map((l, i) => `${String(i + 1).padStart(3)} | ${l}`).join("\n")

const cases = fs
  .readFileSync(casesPath, "utf-8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l))
  .slice(0, LIMIT)
fs.mkdirSync(OUT, { recursive: true })

const records = await pool(cases, 6, async (c, i) => {
  const rule = { id: `shadcn/${c.rule}`, ...RULES[`shadcn/${c.rule}`] }
  const findings = lint(c)
  const design_system = designSystem(c.filename)
  const policy = c.options?.[0] ?? null
  const caseState = {
    rule,
    rule_options: policy ?? "none (default behavior)",
    code: numbered(c.code),
    design_system,
  }
  const record = { i, rule: c.rule, label: c.kind === "invalid", findings }
  try {
    const r = await ask(caseState, QUESTIONS.case)
    record.is_violation = r.answers.is_violation.noul
    record.usage = r.usage
    record.findingAnswers = await Promise.all(
      findings
        .filter((f) => !f.fatal)
        .map(async (f) => {
          const fr = await ask(
            { rule, finding: { line: f.line, message: f.message }, snippet: caseState.code, design_system },
            { message_actionable: QUESTIONS.finding.message_actionable }
          )
          const a = fr.answers.message_actionable
          return { line: f.line, score: a.score, confidence: a.confidence, usage: fr.usage }
        })
    )
  } catch (err) {
    record.error = err.message
  }
  process.stdout.write(record.error ? "x" : ".")
  return { case: c, state: caseState, ...record }
})
console.log()

fs.writeFileSync(path.join(OUT, "records.json"), JSON.stringify(records, null, 2))

// Metrics are code: Jev only supplies probabilities.
const ok = records.filter((r) => typeof r.is_violation === "number")
const at = (t) => {
  let tp = 0, fp = 0, tn = 0, fn = 0
  for (const r of ok) {
    const p = r.is_violation >= t
    if (p && r.label) tp++
    else if (p) fp++
    else if (r.label) fn++
    else tn++
  }
  return { threshold: t, accuracy: +((tp + tn) / ok.length).toFixed(3), precision: +(tp / (tp + fp || 1)).toFixed(3), recall: +(tp / (tp + fn || 1)).toFixed(3), tp, fp, tn, fn }
}
// AUC: chance a random invalid case scores above a random valid one.
const pos = ok.filter((r) => r.label), neg = ok.filter((r) => !r.label)
let wins = 0
for (const p of pos) for (const n of neg) wins += p.is_violation > n.is_violation ? 1 : p.is_violation === n.is_violation ? 0.5 : 0
const byRule = {}
for (const r of ok) {
  const b = (byRule[r.rule] ??= { n: 0, correct_at_0_5: 0, mean_p_invalid: [], mean_p_valid: [] })
  b.n++
  if (r.is_violation >= 0.5 === r.label) b.correct_at_0_5++
  ;(r.label ? b.mean_p_invalid : b.mean_p_valid).push(r.is_violation)
}
const mean = (a) => (a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(3) : null)
for (const b of Object.values(byRule)) {
  b.mean_p_invalid = mean(b.mean_p_invalid)
  b.mean_p_valid = mean(b.mean_p_valid)
}
const scores = records.flatMap((r) => r.findingAnswers ?? []).map((a) => a.score)
// Label sanity: does the real rule agree with the test label?
const labelMismatch = records.filter((r) => (r.findings.filter((f) => !f.fatal).length > 0) !== r.label).length
const summary = {
  cases: records.length,
  errors: records.filter((r) => r.error).length,
  label_vs_real_lint_mismatches: labelMismatch,
  auc: +(wins / (pos.length * neg.length || 1)).toFixed(3),
  thresholds: [0.3, 0.5, 0.7].map(at),
  by_rule: byRule,
  message_actionable: { findings: scores.length, mean: mean(scores), below_1: scores.filter((s) => s < 1).length },
  // Jev bills input tokens only; output_tokens stays in the raw records.
  input_tokens: [...records.map((r) => r.usage), ...records.flatMap((r) => (r.findingAnswers ?? []).map((a) => a.usage))].reduce((t, u) => t + (u?.input_tokens ?? 0), 0),
}
fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2))
console.log(JSON.stringify(summary, null, 2))
console.log(`\n${OUT}`)

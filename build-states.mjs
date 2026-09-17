#!/usr/bin/env node
// Turns a shadcn-ui/lint eval run into System One states.
//
// Usage: node build-states.mjs <results.json> [--out states.jsonl]
//
// One "finding" state per condition-A lint finding (the diagnostics the
// agent was fed) and one "task" state per task (A vs C sources). The
// project's tokens and components come from design-system.json, keyed by
// the run's fixture (packages/evals/<fixture>).
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const RULES = JSON.parse(fs.readFileSync(path.join(here, "rules.json"), "utf-8")).rules
const POLICY =
  "no-restyle allows layout on every component; Card and its Content/Header/Footer/Group/Panel slots also allow spacing. no-arbitrary-values allows layout."

const args = process.argv.slice(2)
const resultsPath = args[0]
if (!resultsPath) {
  console.error("Usage: node build-states.mjs <results.json> [--out states.jsonl]")
  process.exit(1)
}
const outIdx = args.indexOf("--out")
const outPath = outIdx !== -1 ? args[outIdx + 1] : "states.jsonl"

const read = (file) => {
  try {
    return fs.readFileSync(file, "utf-8")
  } catch {
    return ""
  }
}

function snippet(source, line, radius = 3) {
  const lines = source.split("\n")
  const from = Math.max(1, line - radius)
  const to = Math.min(lines.length, line + radius)
  const out = []
  for (let n = from; n <= to; n++) {
    const mark = n === line ? ">" : " "
    out.push(`${mark}${String(n).padStart(4)} | ${lines[n - 1]}`)
  }
  return out.join("\n")
}

const DESIGN = JSON.parse(read(path.join(here, "design-system.json")))
function designSystem(fixture) {
  const ds = DESIGN.projects[`packages/evals/${fixture}`]
  if (!ds) throw new Error(`design-system.json has no entry for packages/evals/${fixture}`)
  return { policy: POLICY, fixture: `packages/evals/${fixture}`, ...ds }
}

const data = JSON.parse(read(resultsPath))
const runDir = path.dirname(path.resolve(resultsPath))
const records = []

for (const r of data.results) {
  const aDir = path.join(runDir, r.task, "a")
  const cDir = path.join(runDir, r.task, "c")
  const task = { id: r.task, prompt: r.prompt, file: r.file }
  const ds = designSystem(data.fixture ?? "fixture")
  const context = {
    run: data.runId,
    model: data.model,
    fixture: data.fixture,
    c_redirect: r.c.redirect,
    c_violations_after: r.c.violations.length,
    c_rounds: r.c.rounds.length,
  }

  for (const f of r.a.violations) {
    // Harness findings (missing file, parse error, agent error) are not lint output.
    if (!RULES[f.rule]) continue
    records.push({
      id: `${r.task}:a:${f.file}:${f.line}:${f.rule}`,
      scope: "finding",
      state: {
        task,
        rule: { id: f.rule, ...RULES[f.rule] },
        finding: { file: f.file, line: f.line, message: f.message },
        snippet: snippet(read(path.join(aDir, f.file)), f.line),
        design_system: ds,
      },
      context: { ...context, condition: "a" },
    })
  }

  records.push({
    id: `${r.task}:task`,
    scope: "task",
    state: {
      task,
      before: { source: read(path.join(aDir, r.file)) },
      after: {
        source: read(path.join(cDir, r.file)),
        redirect: r.c.redirect,
      },
      design_system: ds,
    },
    context,
  })
}

fs.writeFileSync(outPath, records.map((x) => JSON.stringify(x)).join("\n") + "\n")
console.log(
  `${records.length} states (${records.filter((x) => x.scope === "finding").length} findings) -> ${outPath}`
)

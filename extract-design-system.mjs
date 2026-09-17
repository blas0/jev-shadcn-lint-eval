#!/usr/bin/env node
// Writes design-system.json: the real color tokens and component variants
// of each shadcn-ui/lint fixture, read with @shadcn/lint's project API.
// The eval scripts read this file instead of the checkout, so it is the
// source of truth for what Jev is told about each project.
//
// Usage: node extract-design-system.mjs --repo <built shadcn-lint checkout>
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const i = args.indexOf("--repo")
const REPO = i !== -1 ? path.resolve(args[i + 1]) : null
if (!REPO) {
  console.error("Usage: node extract-design-system.mjs --repo <checkout>")
  process.exit(1)
}

// Fixtures that ship a components.json. packages/evals/fixture-ds has none
// (it passes componentImports instead), so it is not listed.
const FIXTURES = [
  "packages/lint/test/fixtures/project",
  "packages/lint/test/fixtures/broken-theme",
  "packages/lint/test/fixtures/prefixed",
  "packages/evals/fixture",
  "packages/evals/fixture-rich",
]

const { project } = await import(
  pathToFileURL(path.join(REPO, "packages/lint/dist/index.js")).href
)
const rel = (file) => path.relative(REPO, file).replace(/\\/g, "/")

const projects = {}
for (const fixture of FIXTURES) {
  const root = path.join(REPO, fixture)
  const probe = path.join(root, "app/page.tsx")
  const meta = project.projectFor(probe)
  const byFile = new Map()
  for (const [name, file] of project.componentsFor(probe)?.files ?? []) {
    if (!byFile.has(file)) byFile.set(file, [])
    byFile.get(file).push(name)
  }
  const components = [...byFile]
    .map(([file, exports]) => ({
      file: path.relative(root, file),
      exports: exports.sort(),
      variants: (project.variantDefinitionsOf(file) ?? [])
        .filter((d) => Object.keys(d.axes).length)
        .map((d) => ({ name: d.name, axes: d.axes })),
    }))
    .sort((a, b) => a.file.localeCompare(b.file))
  projects[fixture] = {
    theme: meta?.cssFile ? path.relative(root, meta.cssFile) : null,
    color_tokens: [...(project.colorTokensFor(probe) ?? [])].sort(),
    components,
  }
}

const out = {
  source: "https://github.com/shadcn-ui/lint",
  commit: execFileSync("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim(),
  outside:
    "The file is outside any shadcn project, so there are no theme tokens or design-system components; only palette and literal checks apply.",
  projects,
}
fs.writeFileSync(path.join(here, "design-system.json"), JSON.stringify(out, null, 2) + "\n")
for (const [k, v] of Object.entries(projects))
  console.log(`${k}: ${v.color_tokens.length} tokens, ${v.components.length} component files`)

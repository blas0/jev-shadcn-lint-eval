# jev-shadcn-lint-eval

This checks [shadcn-ui/lint](https://github.com/shadcn-ui/lint) (commit `53de86f`)
with TypeSafe's Jev model (`jev-latest`). The repo's own eval measures how agents
style UI before and after lint feedback. This one asks Jev whether each lint
result is right and whether its message tells you what to change.

## What's here

- `design-system.json`: the source of truth for what Jev is told about each
  project: the real color tokens, component files and their variants for five
  shadcn-ui/lint fixtures. `extract-design-system.mjs` regenerates it.
- `rules.json`: the six rules, what each one reports, and how to fix it.
- `questions.json`: the questions sent to Jev, grouped by what they judge
  (a single finding, a test case, or a whole agent task).
- `rule-cases.jsonl`: 131 rule test cases (79 should be reported, 52 shouldn't).
- `run-rule-cases.mjs`: runs the real linter on each case, asks Jev, and saves
  `records.json` (every answer) and `summary.json` (the scores) under `results/`.
- `build-states.mjs`: turns an agent run into states for Jev (sample:
  `state.example.json`). Tested once on a made-up run; not sent to Jev yet.

## Running it

You need a checkout of shadcn-ui/lint with `pnpm install` and `pnpm build` done.
To rebuild `rule-cases.jsonl`, temporarily change `createTester()` in
`packages/lint/test/helpers.ts` to write each test case to a file, then run the
six rule test files. Then:

```bash
node extract-design-system.mjs --repo <lint checkout>   # only when the lint repo changes
export TYPESAFE_API_KEY=...                             # never commit it
node run-rule-cases.mjs rule-cases.jsonl --repo <lint checkout> [--limit n]
```

## Test results (2026-09-17)

Run: `results/rule-cases-2026-09-17T07-42-43-159Z/`. The linter's output matched
the test labels on all 131 cases. All 246 requests succeeded: 131 asked whether
the code breaks the rule, and 115 scored real lint messages. The 97 cases inside
the main test project were given its real components and variants. The run used
249,384 input tokens (Jev bills input only; output counts stay in `records.json`).

**Does the code break the rule?** Jev ranked 89% of case pairs correctly.

| Count as "yes" from | Accuracy | Precision | Recall |
| --- | --- | --- | --- |
| 0.3 | 0.68 | 0.66 | 0.97 |
| 0.5 | 0.72 | 0.69 | 0.95 |
| 0.7 | 0.82 | 0.82 | 0.91 |

Jev almost never misses a real problem. Its weak spot is clean code: it gives
clean cases an average of 0.41 to 0.59, depending on the rule.
`no-arbitrary-values` and `no-raw-colors` did best; `no-inline-styles` and
`no-restyle` did worst.

**Does the message say what to change?** Messages are scored from 0 (no help) to
2 (names the exact variant, color, or file). The average was 1.41, and 36 of 115
scored below 1. `no-unknown-classes` scored highest (1.70); `no-inline-styles`
(0.84) and `require-static-classes` (0.91) scored lowest.

**What the misses show:**
- Most wrong "yes" answers happen because Jev isn't told what each rule
  ignores. For example, `no-raw-colors` leaves `bg-[#333]` to another rule, but
  `rules.json` doesn't say so. Allow lists and per-component rules get missed too.
- The lowest-scoring messages are mostly ones like "its contract denies flex",
  which say what's wrong but not what to use instead.
- Earlier runs sent no component data because of a bug. Adding it didn't clearly
  change accuracy (those runs got 0.79 and 0.82 at 0.7), but it did raise input
  tokens by about 60%.

## Next steps

- Tell Jev what each rule ignores (in `rules.json`), then rerun.
- Send `build-states.mjs` output from a real agent run to Jev, and compare its
  answers with the lint repo's own outcome labels.

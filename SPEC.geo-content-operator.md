# GEO Content Operator Spec

## Goal

Add a long-term GEO content operating layer above `geo-article-writer`.

`geo-article-writer` should remain responsible for drafting articles, hooks, visuals, and output files. The new `geo-content-operator` skill should decide whether a topic is worth writing, how it fits the content portfolio, what quality bar it must clear, and whether a generated result should be accepted or rejected.

## Why This Exists

The previous workflow improved structural correctness, but the article could still feel similar to earlier drafts.

The missing layer is not more article-writing instructions. It is content operations:

- portfolio memory
- keyword tiering
- citation feedback
- topic rejection gates
- content mix control
- previous-draft regression checks
- harness iteration until quality gates pass

This mirrors the useful part of `.tmp/GEO_Companion/.claude/agents/andy.md`: the agent prompt is thin, but it depends on runbooks, portfolio memory, citation logs, and content-mix rules.

## Architecture

Add a new bundled skill:

```text
skills/geo-content-operator/
  SKILL.md
  references/
    daily-runbook.md
    content-mix.md
    keyword-portfolio.md
    portfolio-memory.md
    citation-log.md
    promotion-briefs.md
    topic-rejection-gates.md
    harness-runbook.md
```

Responsibilities:

- choose or refine a topic before writing
- identify content lane: category, competitor, adjacency, product-led
- define mention intensity: direct, comparative, ambient
- check duplicate risk against recent portfolio memory
- decide whether the article needs research, examples, or visuals
- generate a production brief for `geo-article-writer`
- run hard checks and Andy-style review
- iterate until gates pass or `max_iterations` is reached

Non-responsibilities:

- writing the final article body
- generating images directly
- publishing to a specific web repo
- running live research unless an external browsing/research capability is explicitly used

## Workflow

1. Intake
   - Parse keyword, business context, audience, language, goal, and requested channels.
   - Determine whether the user is asking for direct article generation, topic selection, or a full evaluation loop.

2. Portfolio and Memory Check
   - Read keyword portfolio, portfolio memory, citation log, and promotion briefs.
   - If no project-local memory exists, use bundled references as templates and state that the memory is sparse.
   - Reject or revise topics that are too close to recent theses.

3. Topic Decision
   - Select content lane.
   - Select mention intensity.
   - Define core claim.
   - Define proof posture: hypothetical, grounded, researched.
   - Define visual policy.

4. Writer Handoff
   - Produce a concise brief for `geo-article-writer`.
   - The brief must include quality gates and output organization expectations.

5. Harness Loop
   - Generate outputs.
   - Run hard checks.
   - Run Andy-style content review.
   - If checks fail, fix the smallest failing part and re-run.
   - If content review says the article is too similar or too generic, revise the brief and re-run.
   - Stop when gates pass or `max_iterations` is reached.

Default `max_iterations`: 3.

## Quality Gates

Hard gates:

- reader-facing article file exists
- metadata lives outside the article file
- core claim appears in opening
- hypothetical examples are labeled
- no fabricated customer names, metrics, quotes, or citations
- unverified factual claims are softened or marked
- requested visuals are generated, saved, and inserted inline
- distribution hooks exist when requested

Soft gates:

- article is materially different from previous drafts
- claim is stronger than a generic category explainer
- examples are specific and not reused without improvement
- article adds a framework, diagnostic, decision rule, or product-specific angle
- X/LinkedIn hooks carry the article's sharpest tension
- generated visuals clarify the argument rather than decorate it

## State Strategy

Bundled references are seed templates. Project-specific state should eventually live outside the package, for example:

```text
~/.selfagent/geo/
  keyword-portfolio.md
  portfolio-memory.md
  citation-log.md
  promotion-briefs.md
```

For the current Codex validation phase, generated harness runs can live under:

```text
.tmp/geo-harness-runs/
```

## Verification

- `npm run build` passes.
- `loadWorkspaceAndConversationSkills` discovers both `geo-article-writer` and `geo-content-operator`.
- A test run for `AI search optimization` creates:
  - article
  - metadata files
  - generated image under `images/`
  - inline image reference in article
  - hard-check report
  - Andy review
  - final report
- The new article should be materially sharper than the previous run, not just structurally valid.

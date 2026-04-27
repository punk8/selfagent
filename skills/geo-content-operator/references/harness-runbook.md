# Harness Runbook

Use this when the task asks to evaluate, retry, improve, or run until checks pass.

Default `max_iterations`: 3.

## Required Run Folder

For Codex validation, write outputs under:

```text
.tmp/geo-harness-runs/[slug]/
```

Recommended structure:

```text
[run]/
  operator-brief.md
  article.md
  images/
  meta/
    article-plan.md
    distribution-hooks.md
    quality-notes.md
    visual-opportunity-scan.md
    previous-draft-comparison.md
  checks/
    hard-checks.md
  reviews/
    andy-review.md
  report.md
```

## Loop

1. Create an operator brief.
2. Generate the article and metadata through `geo-article-writer`.
3. Generate images when required and editorially justified.
4. Insert generated image references into `article.md`.
5. Run hard checks.
6. Run Andy-style content review.
7. If hard checks fail, fix only the failed checks.
8. If review says the article is generic or duplicative, revise the brief and regenerate the relevant section.
9. Repeat until pass or `max_iterations`.

## Hard Checks

Check:

- `article.md` exists and is reader-facing
- metadata is under `meta/`, not appended to the article
- distribution hooks exist when requested
- image files exist when images were required
- generated images are referenced inline from the article
- the core claim appears in the opening
- examples are labeled hypothetical unless sourced
- no fake customer names, metrics, quotes, citations, or live research claims
- previous-draft comparison exists for repeated topics
- final report records iteration count and pass/fail

## Andy-Style Review

The review should answer:

- Is this a new article or a rewrite of the same article?
- What is the strongest claim?
- What would a skeptical founder or content lead object to?
- Are examples specific enough to be useful?
- Does the visual clarify the argument?
- Are LinkedIn/X hooks based on the article's sharpest tension?
- What should be fixed before publishing?

Pass only when the article is both structurally valid and meaningfully sharper than the prior draft.

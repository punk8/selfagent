# Output Quality Reference

Use this reference before finalizing substantial GEO articles.

## Article Quality Checklist

Check:

- The article answers the core question directly near the top.
- The title is credible and not clickbait.
- The structure is easy for a human and an AI answer engine to parse.
- Each section has a distinct purpose.
- Keyword usage is natural.
- The article includes definitions, comparisons, steps, or examples where useful.
- The article includes at least one concrete artifact unless the format makes that inappropriate.
- Unsupported factual claims are marked for sourcing or softened.
- The ending gives a practical operating takeaway.

## GEO Readiness

Prefer:

- direct answer blocks
- explicit definitions
- numbered steps
- comparison tables
- FAQ-style sections when appropriate
- named entities and clear relationships
- concrete examples
- before/after examples, diagnostics, decision rules, or implementation checklists
- citations or source placeholders when evidence is missing

Avoid:

- vague expertise claims
- generic best-practice filler
- unverifiable statistics
- invented quotes or citations
- keyword stuffing
- social-media formatting inside the article body

## Specificity Check

Substantial articles should include at least one concrete artifact:

- example
- scenario
- before/after comparison
- diagnostic
- checklist
- decision rule
- sourced reference

This is a specificity requirement, not a requirement to turn every article into a case study.

If examples do not fit the format, replace them with a concrete scenario, decision rule, checklist, comparison, or sourced reference.

Before finalizing, ask:

- Does the article make one visible core claim?
- Are generic claims converted into observable behavior?
- Can a reader recognize themselves in at least one scenario, example, or diagnostic?
- Does the first section contain a useful insight, not just a definition?
- Could the first 5 lines stand alone as a strong social excerpt?

## Example Source Policy

Classify examples by source:

- `hypothetical`: created to illustrate a concept; must be clearly framed as an example or scenario
- `grounded`: based on user-provided URLs, screenshots, product facts, customer examples, internal data, or audit notes
- `researched`: based on live search, fetched pages, or external sources

Use hypothetical examples when no source material is available.

Use grounded examples when the user supplies product details, customer context, URLs, screenshots, or internal observations.

Use researched examples only when an available research or browsing tool is explicitly used. Include links or source notes when possible.

Do not invent:

- customer names
- company names presented as real
- metrics
- quotes
- third-party citations
- case-study outcomes

## Evidence Pressure Test

Before publishing-style output, inspect factual claims:

- Keep reasoning-based claims if they are framed as analysis.
- Mark market, platform, benchmark, or customer claims with `[source needed]` when no source is supplied.
- Prefer "for example, a hypothetical B2B SaaS page..." over fake proof.
- If a claim would materially affect a business decision, either support it with supplied evidence or soften it.

## Writing Methods

Use W.R.I.T.E for research-backed or insight-led articles:

- Write: draft the core argument quickly.
- Research: add supplied evidence or mark missing evidence.
- Ideate: sharpen the title, hook, and angle.
- Target: adapt examples and depth to the audience.
- Enhance: improve clarity, structure, and credibility.

Use Content Writing Process for SEO/GEO guides:

- Planning: define audience, intent, keyword, and outline.
- Research: use supplied facts or mark missing sources.
- Writing: expand the outline into complete sections.
- Editing: tighten logic and remove filler.
- Publishing: add headings, answer blocks, and distribution notes if requested.

## Evidence Policy

If the user supplies no sources:

- Do not invent external statistics.
- Use cautious language.
- Add `[source needed]` only where a factual claim needs validation.
- Prefer claims based on reasoning, definitions, transparent assumptions, and hypothetical examples.

If the user supplies URLs or data:

- Ground claims in the supplied material.
- Distinguish observed evidence from recommendation.
- Mention when page context is incomplete.

## Final Output Modes

### Complete article

Use when the user says "write", "generate", "draft", or "create the article".

Output:

- title
- full article body
- short article plan summary
- quality notes

### Article plan only

Use when the user asks for a plan, outline, or brief.

Output:

- title options
- selected hook pattern
- article promise
- sections
- keyword placement
- writing notes

### Article plus distribution

Use when platforms are named or the user asks for promotion/repurposing.

Output:

- full article
- distribution hooks
- repurpose notes

### Article plus visual prompt

Use when the user asks for images, diagrams, visual assets, or when a visual is clearly useful.

Output:

- full article or requested section
- visual asset recommendation
- image prompt
- caption
- alt text

## File-Based Output Organization

When writing article output to files, keep the main article file reader-facing.

The article file should include:

- title
- article body
- inline image references when images are generated
- captions where useful
- FAQ or conclusion if part of the article

Move editor-facing material into adjacent metadata files when possible:

- distribution hooks
- article plan
- quality notes
- visual opportunity scan
- image prompts

Recommended structure:

```text
[article-folder]/
  article.md
  images/
    [image files]
  meta/
    distribution-hooks.md
    article-plan.md
    quality-notes.md
    visual-opportunity-scan.md
    image-prompts.md
```

Do not append editor-facing metadata to the reader-facing article unless the user asks for a single combined file.

## Harness Iteration

When this skill is used inside an evaluation or harness workflow, do not treat the first output as final if hard checks fail.

Use this loop:

1. Generate the article assets.
2. Run hard checks.
3. Fix only the failed checks.
4. Re-run hard checks.
5. Stop when all hard checks pass or the configured max iteration count is reached.

Default max iterations: 3.

When the user explicitly asks to generate images, check that:

- the visual scan selected at least one useful visual unless none are editorially justified
- generated image files exist under `images/` or the requested destination
- generated images are referenced inline from the article body
- image prompts and visual decisions are recorded in `meta/`

## Length Guidance

Unless the user specifies length:

- short article: 700-1,000 words
- standard article: 1,200-1,800 words
- deep article: 2,000+ words

For Telegram delivery, keep the first response practical. If the article is long, offer to continue or provide sections in batches.

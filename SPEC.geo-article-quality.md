# GEO Article Quality Upgrade Spec

## Goal

Improve `geo-article-writer` so generated articles are less generic and more useful for distribution, especially on X/LinkedIn and company blogs.

The upgrade should make articles produce:

- a stronger, debatable core claim
- more concrete examples, scenarios, comparisons, or diagnostics
- clearer evidence boundaries
- optional visual asset prompts when a diagram or image would improve the article

## Problem

The first version can produce structurally correct GEO articles, but the output can still feel safe:

- the article explains the topic but may not make a memorable argument
- examples may be too abstract
- distribution hooks can be stronger than the article body
- image/diagram opportunities are not explicitly identified

This is not a runtime problem. It is a planning and quality-control problem inside the skill.

## Design

### 1. Core Claim Generation

`article-plan.md` should require every substantial article to define one core claim before drafting.

The core claim should usually be:

- debatable
- specific
- useful to the target reader
- narrow enough to guide the article
- falsifiable or at least inspectable

Weak:

- "AI search optimization is important."

Stronger:

- "Most B2B SaaS content is invisible to AI search because it describes features, not recommendation contexts."

The claim can be softened for neutral formats such as release notes, product docs, short definitions, or compliance content.

### 2. Specificity And Evidence Pressure Test

`output-quality.md` should add a default requirement that every substantial article contains at least one concrete artifact:

- example
- scenario
- before/after comparison
- diagnostic
- checklist
- decision rule
- sourced reference

The rule should enforce specificity, not force every article into a case-study format.

### 3. Example Source Policy

Examples should be categorized by source:

- `hypothetical`: created to illustrate a concept; must not pretend to be real
- `grounded`: based on user-provided URLs, screenshots, product facts, customer examples, or internal data
- `researched`: based on live search or fetched external sources

For phase 1, the skill should support `hypothetical` and `grounded` examples. `researched` examples require a future research tool or explicit browsing capability.

The skill must not invent company names, customer claims, metrics, citations, or case studies.

### 4. Visual Asset Planning

Add `references/visual-assets.md`.

The skill should identify optional visuals when an article includes:

- abstract frameworks
- workflows
- comparison tables
- checklists
- before/after examples
- diagnostics

The skill should not generate images by default. It should:

1. propose where a visual would help
2. generate an image prompt using the article context
3. include caption and alt text
4. call an image generation capability only when available and requested
5. insert generated image references into the article body at the selected placements

If image generation is not available, output the prompt for later use.

For early validation, the image generation path is Codex-specific:

- use the available `$imagegen` skill
- prefer built-in `image_gen` mode
- use the generated image prompt plus article context as input
- save project-bound validation assets under `.tmp/geo-article-assets/` unless another path is requested

TODO: later replace this with a SelfAgent-native image generation tool and channel delivery path.

### 5. Platform Hook Tightening

`platform-hooks.md` should prefer hooks that reuse the article's core claim and one concrete artifact.

For X, the first lines should be short and tension-led, not definition-led.

For LinkedIn, the hook should connect the claim to a business implication and avoid generic thought-leadership language.

### 6. File-Based Output Organization

When writing generated article assets to disk, keep the primary article file reader-facing.

Move editor-facing materials to adjacent metadata files:

- distribution hooks
- article plan
- quality notes
- visual opportunity scan
- image prompts

Generated images should live under an adjacent `images/` directory and be referenced inline from the article body.

### 7. Harness Iteration Loop

When running this as an evaluation workflow, the harness should not stop after the first generation if checks fail.

Default loop:

1. Generate planner brief, article, visuals, and metadata.
2. Run hard checks.
3. If checks fail, apply the smallest fix that addresses the failures.
4. Re-run hard checks.
5. Repeat until all hard checks pass or `max_iterations` is reached.

Default `max_iterations`: 3.

If the user explicitly asks to generate images, image generation becomes a hard requirement:

- at least one selected visual should be generated when the visual scan identifies a useful visual
- generated images must be saved under `images/`
- generated images must be inserted into the article body
- `meta/visual-opportunity-scan.md` must record which visuals were generated and why

## Non-Goals

This upgrade does not add:

- a live research tool
- web crawling
- SelfAgent-native automatic image generation
- Telegram image delivery changes
- publication workflow changes

## Implementation Plan

1. Update `skills/geo-article-writer/SKILL.md`
   - mention core claim generation
   - mention specificity/evidence quality pass
   - mention optional visual asset prompt workflow

2. Update `references/article-plan.md`
   - add core claim to the planning schema
   - define strong vs weak claims
   - make the claim drive title, opening, and sections

3. Update `references/output-quality.md`
   - add specificity check
   - add evidence pressure test
   - add example source policy

4. Add `references/visual-assets.md`
   - define visual opportunity rules
   - define image prompt shape
   - define caption/alt text output
   - define Codex `$imagegen` validation mode
   - require generated images to be inserted into the article body
   - define the future SelfAgent migration TODO
   - define image generation boundary

5. Update `references/platform-hooks.md`
   - make X hooks use the core claim, short lines, and a concrete example early
   - make LinkedIn hooks connect the claim to operational impact

6. Update file-output rules
   - keep reader-facing article content separate from editor-facing metadata
   - prefer `images/` for generated visuals
   - prefer `meta/` for distribution hooks, plans, quality notes, visual scans, and prompts

7. Update harness loop rules
   - run checks after generation
   - fix failed checks and re-run until pass or max iterations
   - treat requested image generation as a hard check

## Verification

Minimum verification:

- `geo-article-writer` still loads as a skill
- `npm run build` passes
- generated npm package includes the new reference file

Manual output review should check:

- the article has one clear core claim
- the article includes at least one concrete example/scenario/comparison/diagnostic unless format makes that inappropriate
- unsupported real-world claims are marked for sourcing
- visual prompts are only included when useful or requested
- generated images are inserted into the article body, not only listed in an appendix
- file-based outputs keep reader-facing article content separate from metadata when possible
- harness runs continue until hard checks pass or max iterations is reached

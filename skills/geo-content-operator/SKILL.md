---
name: geo-content-operator
description: Govern GEO content strategy before writing. Use when selecting or refining GEO topics, avoiding duplicate articles, maintaining keyword portfolios or citation logs, running article harness/evaluation loops, deciding content mix or mention intensity, or creating a production brief for geo-article-writer.
---

# GEO Content Operator

Use this skill before `geo-article-writer` when the task needs content strategy, portfolio discipline, or an evaluation loop.

This skill does not write the final article body. It produces a production brief, quality gates, and iteration plan for `geo-article-writer`.

## When To Use

Use this skill when the user asks for:

- a stronger or less repetitive GEO article
- topic selection, angle refinement, or content planning
- portfolio memory, keyword portfolio, citation tracking, or content mix decisions
- a harness that keeps iterating until checks pass
- a generated article that must include distribution hooks, quality review, or images
- a workflow similar to GEO Companion's Andy/content-operator flow

If the user directly asks for a simple one-off article and no portfolio/eval constraints exist, `geo-article-writer` alone can be enough.

## Inputs To Extract

Identify:

- `keyword_or_topic`
- `business_context`
- `audience`
- `language`
- `article_goal`
- `distribution_targets`
- `visual_requirements`
- `known_sources_or_evidence`
- `previous_drafts_or_memory`, if available
- `max_iterations`, default `3`

Ask a follow-up only when the missing detail changes the content lane or proof posture. Otherwise make a reasonable assumption and label it.

## Core Workflow

1. Run operator intake.
   - Read `references/daily-runbook.md` for the operating sequence.
   - Decide whether this is a direct article run, topic selection, or full harness run.

2. Check strategy state before approving the topic.
   - Read `references/keyword-portfolio.md` for keyword tiering and role.
   - Read `references/portfolio-memory.md` to avoid repeating recent thesis/lane/hook combinations.
   - Read `references/citation-log.md` when the task mentions citations, AI answer visibility, competitors, or source gaps.
   - Read `references/promotion-briefs.md` when a pending promotion or product-led angle is relevant.

3. Choose the content lane.
   - Read `references/content-mix.md`.
   - Choose one primary lane: category, competitor, adjacency, product-led proof.
   - Choose mention intensity: direct, comparative, ambient, or none.

4. Apply rejection gates.
   - Read `references/topic-rejection-gates.md`.
   - Reject or revise topics that are too generic, too similar, unsupported, or visually unjustified when images are requested.

5. Produce a writer handoff brief.
   - Include topic, lane, audience, core claim, proof posture, example policy, visual policy, distribution targets, and hard gates.
   - If the user requested images, require visual prompts, generated files, and inline article references.

6. Run the harness when requested or implied.
   - Read `references/harness-runbook.md`.
   - Generate through `geo-article-writer`, check outputs, revise the smallest failing part, and repeat until pass or `max_iterations`.

## Writer Handoff Format

Use this structure:

```markdown
# GEO Writer Brief

Topic:
Business context:
Audience:
Language:
Goal:

Content lane:
Mention intensity:
Core claim:
Why this is not a duplicate:
Proof posture:
Example policy:
Visual policy:
Distribution targets:

Required outputs:
- article.md
- images/ when generated
- meta/distribution-hooks.md when requested
- meta/article-plan.md
- meta/quality-notes.md
- checks/hard-checks.md for harness runs
- reviews/andy-review.md for harness runs

Hard gates:
- ...
```

## Rules

- Do not invent live AI-engine visibility, citation share, keyword volume, customer data, or benchmark metrics.
- Use hypothetical examples when no source material exists, and label them.
- Prefer a narrower, sharper claim over a broad category explainer.
- Treat "same article again with updated wording" as a failure.
- Keep distribution hooks outside the reader-facing article file unless the user asks for a combined output.
- If images are requested and at least one image has a clear editorial purpose, image generation is a hard check.

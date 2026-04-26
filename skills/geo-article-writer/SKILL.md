---
name: geo-article-writer
description: Generate GEO-friendly long-form articles from keywords, topics, brand context, or audit insights. Use for SEO/GEO blog posts, article plans, founder articles, AI visibility content, optional platform-specific distribution hooks, and optional visual asset prompts.
---

# GEO Article Writer

Use this skill to turn a keyword, topic, website insight, or GEO opportunity into a publishable article.

The workflow combines:

- article planning from GEO Companion's keyword article planner
- platform hook guidance from GEO Companion's hook library
- professional writing discipline similar to super-writer
- specificity, evidence, and visual asset quality checks

## When To Use

Use this skill when the user asks for:

- a GEO, SEO, or AI visibility article
- a blog post from a keyword
- an article plan plus full draft
- founder-style or company-site thought leadership
- content that should later be repurposed to LinkedIn, X, Reddit, Medium, YouTube, TikTok, Instagram, or Rednote
- article visuals, diagram prompts, framework cards, or image-generation prompts for GEO content

## Inputs To Extract

Before writing, identify:

- `topic_or_keyword`
- `business_context`
- `audience`
- `search_intent`
- `article_goal`
- `language`
- `target_platforms`, if distribution hooks are requested
- `visual_requirements`, if images, diagrams, or visual prompts are requested
- `evidence_available`, such as supplied facts, URLs, data, examples, or audit notes

Ask a follow-up only when the missing detail changes the article direction. Otherwise make a reasonable assumption and state it briefly.

## Core Workflow

1. Build an article plan.
   - Read `references/article-plan.md` when planning the article.
   - Define one core claim before drafting.
   - Choose exactly one SEO blog hook pattern.
   - Map it to one canonical hook pattern.
   - Define the article promise and 4-5 sections.

2. Draft the full article.
   - Use W.R.I.T.E or Content Writing Process depending on complexity.
   - Write a complete article, not only an outline.
   - Keep the tone serious, useful, and publication-ready.

3. Add platform hooks only when useful.
   - Read `references/platform-hooks.md` when the user asks for social/platform distribution or when repurposing is clearly part of the task.
   - Keep social hook style out of the article body.

4. Run the quality pass.
   - Read `references/output-quality.md` before finalizing substantial articles.
   - Check the article has a specific claim, concrete artifact, and clear evidence boundaries.
   - Flag missing external evidence instead of inventing facts.

5. Add visual asset prompts when useful or requested.
   - Read `references/visual-assets.md` when the user asks for images, diagrams, visuals, or when the article would clearly benefit from a framework, workflow, comparison, checklist, or before/after visual.
   - Generate the visual prompt before image generation.
   - During Codex validation, use the available `imagegen` skill / built-in `image_gen` tool when the user asks to actually generate the image.
   - Only claim an image was generated if an image-generation capability was actually invoked.

## Default Output

For a normal article request, output:

```markdown
# [Article Title]

[Full article]

---

Article plan
- Core claim: ...
- Hook pattern: ...
- Search intent: ...
- Article promise: ...
- Keyword placement: ...

Quality notes
- ...

Visual asset prompt
- Include only when requested or clearly useful.
```

If the user asks for a shorter deliverable, follow their requested format.

For file-based article output, keep the main article file reader-facing. Move distribution hooks, article plan, quality notes, visual opportunity scans, and image prompts into adjacent metadata files when possible.

## Writing Rules

- Do not use emojis.
- Do not use clickbait.
- Avoid hype words such as "ultimate", "secret", "game-changing", "10x", and "you won't believe".
- Avoid generic SEO filler.
- Prefer clear definitions, operational lessons, tradeoffs, examples, checklists, comparisons, and direct answers.
- Prefer specific examples, scenarios, diagnostics, or before/after comparisons over abstract advice.
- If research is needed but not provided, write with explicit placeholders such as `[add source]` or state that external validation is needed.
- Match the user's requested language.

## Tool Boundary

This phase is skill-only.

Do not pretend to have live keyword volume, competitor ranking, or page-crawl data unless the user supplies it or an available tool is explicitly used to fetch it.

Do not pretend to generate images unless an image-generation tool or skill is available and has been used. In Codex validation, prefer the `imagegen` skill's built-in tool mode. If image generation is unavailable, output a reusable image prompt instead.

# SelfAgent GEO Article Agent Spec

## Goal

Create a dedicated GEO-focused SelfAgent branch that can turn a keyword, topic, brand context, or audit insight into a publishable long-form article.

The first version should use skills, not runtime tools, because the core work is strategy, structure, and writing method rather than external data fetching or deterministic computation.

## Source References

The design borrows from `.tmp/GEO_Companion`:

- `platforms/hookRegistry.ts`: canonical hook patterns
- `platforms/seoBlogRegistry.ts`: blog article hook patterns
- `prompts/keywords/articlePlan.prompt.ts`: keyword-to-article-plan workflow
- `services/keywordArticlePlanService.ts`: article plan normalization shape
- `platforms/definitions/*`: platform-native distribution behavior

It also borrows the writing workflow shape from the local `super-writer` skill:

- understand task and audience
- choose an appropriate writing method
- draft, refine, and output publishable content

## Product Behavior

The GEO article agent should support requests like:

- "Write a GEO article for this keyword."
- "Turn this keyword opportunity into a company blog post."
- "Create an article and also give me LinkedIn/X distribution hooks."
- "Use this topic to write a serious founder-style article."

The output should usually include:

- article plan
- full article
- optional distribution hooks or social repurposing notes
- short quality checklist

The agent should ask follow-up questions only when required information is missing and cannot be reasonably inferred.

## Phase 1 Design

Phase 1 is skill-only.

Add one workspace skill:

- `skills/geo-article-writer`

The skill owns:

- keyword-to-article planning
- GEO-friendly article structure
- blog hook pattern selection
- platform hook guidance
- full article drafting workflow

Supporting references:

- `references/article-plan.md`
- `references/platform-hooks.md`
- `references/output-quality.md`

This keeps the system lightweight and avoids adding custom tools before the workflow is validated.

## Why Skill First

Use skills for:

- platform hook rules
- article planning heuristics
- writing workflow
- output expectations
- editorial quality checks

Use tools later for:

- live page context fetching
- competitor analysis
- keyword metrics
- fixed-schema article plan generation
- structured report export

The current target is article production, so skills are enough.

## Workflow

1. Parse the user request
   - topic or keyword
   - audience
   - business or brand context
   - search intent
   - desired language
   - target platforms, if any

2. Build an article plan
   - choose one SEO blog hook pattern
   - map it to one canonical hook pattern
   - define article promise
   - define 4-5 sections
   - define keyword placement
   - define writing notes

3. Draft the article
   - use a serious operator-style voice
   - prioritize answerability and citation usefulness
   - include direct answers, definitions, steps, comparisons, and evidence prompts where useful
   - avoid clickbait, hype, and social-post formatting in the article body

4. Add distribution layer when requested
   - use platform-native hooks
   - adapt the article into platform-specific first lines or post angles
   - do not let social hook style contaminate the article body

5. Self-check
   - check title, structure, answerability, keyword usage, and credibility
   - flag missing facts or external research needs instead of inventing evidence

## Non-Goals

Phase 1 does not add:

- custom runtime tools
- web research or keyword-volume lookup
- automatic publishing
- external API calls to GEO Companion
- Supabase entitlement or account logic
- UI changes

## Future Tool Candidates

After the skill is validated, these can become runtime tools:

- `article_plan`
  - input: keyword, intent, business context, audience, locale
  - output: fixed JSON article plan

- `platform_hooks`
  - input: topic, audience, platforms, content goal
  - output: platform-specific hook options and format guidance

- `geo_page_context`
  - input: URL
  - output: cleaned page context

- `geo_audit`
  - input: URL, business type, competitors
  - output: structured GEO analysis

## Verification

Minimum verification:

- `loadSkillsFromDir` discovers `geo-article-writer`
- `npm run build` passes
- a prompt asking for a GEO article has enough skill instructions to produce:
  - article plan
  - complete article
  - optional platform hooks

Manual output review should check that:

- the article is not just an outline
- social hook language does not dominate the article body
- unsupported facts are marked as research-needed
- the output is useful for a company blog or founder publication

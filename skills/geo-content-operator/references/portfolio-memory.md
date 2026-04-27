# Portfolio Memory

Use this to prevent repeat articles.

For production, keep project-specific memory outside the package, for example:

```text
~/.selfagent/geo/portfolio-memory.md
```

## Memory Entry Schema

```markdown
## [date] [title or slug]

- keyword:
- lane:
- audience:
- thesis:
- hook pattern:
- core artifact:
- examples:
- visuals:
- distribution angle:
- status: draft | published | retired
```

## Duplicate Risk Check

Before approving a new article, compare against the last 14 substantial entries.

Hard reject if:

- the thesis is the same with only different wording
- the hook repeats the same misconception or opening
- the same keyword, lane, and artifact appear together again
- a serious reader would say "this is the same article again"

Revise if:

- the topic is the same but the audience changes
- the keyword is the same but the artifact is new
- the article updates an old claim with new evidence

Approve if:

- the article creates a new decision rule, framework, diagnostic, or proof path
- the article serves a different portfolio role
- it resolves a known citation or buyer-question gap

## Starter Memory For Current Validation

The previous validation draft for "AI search optimization" used a broad framework/explainer angle for B2B SaaS teams, included a generated framework image, and produced LinkedIn/X hooks.

A new validation run should avoid repeating "AI search optimization is more than SEO" as the main claim. It should introduce a sharper operating frame and a more specific artifact.

# Visual Assets Reference

Use this reference when the user asks for images, diagrams, visual prompts, article cards, or when an article would clearly benefit from a visual explanation.

## When To Suggest A Visual

Suggest a visual when the article includes:

- abstract frameworks
- workflows or process steps
- comparisons
- checklists
- diagnostics
- before/after examples
- maturity models
- decision rules

Do not force visuals into short definitions, release notes, plain announcements, or articles where a visual would only be decorative.

## Best Visual Types

### Framework Diagram

Use for conceptual models.

Examples:

- "AI Search Optimization Readiness Model"
- "Brand Entity -> Recommendation Context -> Evidence -> Citation"

### Workflow Diagram

Use for step-by-step operating processes.

Examples:

- buyer question -> AI answer -> cited sources -> brand inclusion
- keyword opportunity -> article plan -> article -> distribution hooks -> measurement

### Comparison Card

Use when the article contrasts two approaches.

Examples:

- Traditional SEO vs AI Search Optimization
- weak SaaS content vs GEO-ready SaaS content

### Diagnostic Checklist

Use when the article gives readers a way to evaluate themselves.

Examples:

- "Can AI understand who your product is for?"
- "Does this page explain when your product should be recommended?"

### Before/After Example

Use when the article improves a weak sentence, page section, product description, or claim.

Examples:

- Before: "We help teams grow with AI."
- After: "We help B2B SaaS content teams monitor whether their brand appears in AI answers for high-intent buyer questions."

## Visual Output Shape

When including a visual recommendation, output:

````markdown
Visual asset
- Placement: [where it belongs in the article]
- Type: [framework diagram / workflow / comparison card / checklist / before-after]
- Purpose: [what the visual clarifies]
- Caption: ...
- Alt text: ...

Image prompt
```text
[prompt]
```
````

## Article Insertion Rule

When an image is generated for an article, insert the Markdown image reference at the selected placement in the article body.

Do not only list the file path in the visual asset appendix.

Use relative paths when the article and image files are in the same folder or nearby project folders.

For file-based article output, prefer saving generated images under an adjacent `images/` directory and referencing them from the article body.

Recommended insertion format:

```markdown
![short descriptive alt text](./image-file-name.png)

_One-sentence caption._
```

The visual asset metadata may still include file path, prompt, caption, and alt text for traceability, but the article body should contain the actual image reference.

For file-based output, keep visual metadata in an adjacent `meta/visual-opportunity-scan.md` or `meta/image-prompts.md` file when possible.

## Image Prompt Rules

Generate the image prompt before using image generation.

The prompt should include:

- article title
- target reader
- visual type
- exact concept to show
- key labels to include
- style direction
- constraints such as no fake logos, no unreadable tiny text, no decorative AI robots

Prefer clean editorial diagrams over generic AI imagery.

Use:

- high-contrast editorial layout
- clear labels
- restrained color palette
- simple geometric structure
- modern B2B SaaS visual language

Avoid:

- robot faces
- glowing brains
- random network nodes
- fake dashboard screenshots
- illegible microtext
- made-up customer logos
- overproduced stock-art style

## Image Prompt Template

```text
Create a clean editorial [visual type] for a B2B SaaS article titled "[article title]".

Audience: [target reader].

The visual should explain: [specific idea from the article].

Show these labeled elements:
- [label 1]
- [label 2]
- [label 3]

Use a modern B2B SaaS design style with a restrained palette, clear hierarchy, readable labels, and no decorative AI robots.

Do not include fake logos, fake metrics, fake screenshots, or unreadable small text.
```

## Codex Validation Mode

During early validation in Codex, use the available `imagegen` skill when the user asks to actually generate the image.

Use the generated image prompt plus the article context as the primary image request.

Prefer `imagegen` built-in tool mode. Do not use the fallback CLI unless the user explicitly asks for CLI/API/model control or confirms a required fallback path.

Most GEO article visuals should map to these imagegen use cases:

- `infographic-diagram` for frameworks, workflows, comparison cards, and explainers
- `productivity-visual` for checklist cards, process diagrams, and business visuals

For project-bound validation assets, save or move final outputs into the workspace when possible, preferably under `.tmp/geo-article-assets/` unless the user names another path.

TODO: when SelfAgent gets native image generation support, replace this Codex-specific path with a SelfAgent runtime tool that can generate the image and deliver it through the active channel.

## Image Generation Boundary

If an image-generation capability is available and the user asks to generate an image, use the image prompt plus the article context.

If image generation is unavailable or the user did not ask to generate the image, output the prompt only.

Do not claim an image exists unless it was actually generated.

## Caption And Alt Text

Caption should explain the visual's editorial point in one sentence.

Alt text should describe the visible structure and labels clearly for accessibility.

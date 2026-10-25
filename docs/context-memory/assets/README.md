# Diagram sources

An introductory hero and three explanatory diagrams for the project [README](../../../README.md). They are drawings, not screenshots or benchmark output. Every figure is hand-authored SVG, and the PNG beside it is the render the README embeds: 1660px wide for the hero, 1600px wide for the three diagrams.

- `pi-context-compaction-hero-editorial`: the introductory illustration, focused on tracing a checked handover back to the original failure and later user decision. Its short-handover comparison illustrates what could be lost; it is not a measured comparison with another compactor.
- `source-linked-compaction`: the two layers, the active context after compaction and the session record on disk, with the write path and the `context_history` retrieval path between them.
- `commit-gate`: how the extension commits a checkpoint. The draft note must pass four checks, and Pi's saved copy must be read back from disk. Any failure leaves the checkpoint uncommitted and requests paused until `/compact` commits a new checkpoint or `/compaction-recover` confirms one Pi already saved.
- `recovery-example`: the values in the [documented provider scenario](../validation.md#real-provider-scenario), presented as an illustrative sequence in which one question needs two retrievals from two points in time.

Every figure has a dark counterpart, a `*-dark.svg` source and its PNG render, with identical geometry and wording and a palette picked for a dark canvas. The README selects between the two themes with a `<picture>` element and `prefers-color-scheme`. Descriptive alt text lives on the `<img>` tag in the README.

## Revising a diagram

Edit the SVG, re-render the PNG, and apply the same change to the dark counterpart in the same commit, so the pair stays geometrically identical and swaps without reflow. Check every label against the current implementation and the validation record.

```sh
rsvg-convert -w 1600 source-linked-compaction.svg -o source-linked-compaction.png
rsvg-convert -w 1660 pi-context-compaction-hero-editorial.svg -o pi-context-compaction-hero-editorial.png
```

The SVG sources hold to a few constraints, because GitHub sanitizes SVG served through Markdown and because these files render on machines whose fonts are unknown: web-safe font stacks only, no `<style>` element, no external or remote references, explicit `width` and `height` alongside `viewBox`, and all text as real `<text>` nodes rather than paths.

## History

The first two diagrams, added in PR #20, were produced with an image-generation tool and reviewed for wording, arrow direction and source semantics. They were replaced by these vector sources, and `commit-gate` was added at the same time. The hero was first supplied as a PNG pair only. Its SVG sources were added when it was redrawn for the SLICE name and threshold compaction, and `commit-gate` was redrawn then for the independent extension's commit and readback.

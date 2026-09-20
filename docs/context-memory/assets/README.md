# Diagram sources

Three explanatory diagrams for the project [README](../../../README.md). Each one is hand-authored SVG; the PNG beside it is a 1600px-wide render and is what the README embeds. They are drawings, not screenshots or benchmark output.

- `source-linked-compaction`: the two layers, the active context after compaction and the session record on disk, with the write path and the `context_history` retrieval path between them.
- `commit-gate`: the three checks that run before a checkpoint is published, and what happens on each outcome.
- `recovery-example`: the values in the [documented provider scenario](../validation.md#real-provider-scenario), presented as an illustrative sequence in which one question needs two retrievals from two points in time.

Every figure has a dark counterpart, `*-dark.svg` and `*-dark.png`, with identical geometry and wording and a palette picked for a dark canvas. The README selects between the two with a `<picture>` element and `prefers-color-scheme`. Descriptive alt text lives on the `<img>` tag in the README.

## Revising a diagram

Edit the SVG, re-render the PNG, and apply the same change to the dark counterpart in the same commit, so the pair stays geometrically identical and swaps without reflow. Check every label against the current implementation and the validation record.

```sh
rsvg-convert -w 1600 source-linked-compaction.svg -o source-linked-compaction.png
```

The SVG sources hold to a few constraints, because GitHub sanitizes SVG served through Markdown and because these files render on machines whose fonts are unknown: web-safe font stacks only, no `<style>` element, no external or remote references, explicit `width` and `height` alongside `viewBox`, and all text as real `<text>` nodes rather than paths.

## History

The first two diagrams, added in PR #20, were produced with an image-generation tool and reviewed for wording, arrow direction and source semantics. They were replaced by these vector sources, and `commit-gate` was added at the same time.

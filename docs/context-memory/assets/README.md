# Diagram sources

These are explanatory illustrations generated with the built-in image-generation tool and reviewed for text, source semantics and arrow direction. They are not screenshots or benchmark output. The tool did not expose a selectable model identifier.

- `source-linked-compaction.png`: the checkpoint and history-retrieval mechanism.
- `recovery-example.png`: the values in the [documented provider scenario](../validation.md#real-provider-scenario), presented as an illustrative sequence.

Equivalent explanations and descriptive alt text are included in the [README](../../../README.md). To revise a diagram, regenerate or edit the image and check every label against the current implementation and validation record.

## Overview prompt

```text
Use case: infographic-diagram
Asset type: Public GitHub README explanatory diagram for Pi Context Compaction.
Primary request: Create one refined, technically accurate explanatory flowchart, landscape 1536x1024 or similar, extremely legible when embedded at 850 CSS pixels. Flat editorial information design, white background, dark navy typography, muted teal for retained source records, muted violet for compact notes. Fine crisp borders, spacious layout, simple document symbols, no decorative art, no gradients, no robot, no fake terminal UI.
Main headline exactly: "Compact the context, not the evidence."
Subtitle exactly: "Source-linked context compaction for Pi"
Upper horizontal flow of three distinct cards, left to right, with clear arrowheads:
Card 1 title "Original session", small text "Messages and tool results".
Arrow 1 caption "Write + validate".
Card 2 title "Checkpoint", small text "Task state, next steps, source IDs".
Arrow 2 caption "Resume".
Card 3 title "Active context", small text "Continue from the handover note".
Below these cards, a separated retrieval lane:
Left lower card title "Original records", small text "Retained in session JSONL".
A vertical downward arrow from Original session to Original records, caption "Preserve".
Right lower card title "context_history", small text "Search and read this branch".
A vertical downward arrow from Active context to context_history, caption "Check a detail".
Between the lower cards two clearly separated horizontal arrows: upper arrow goes RIGHT TO LEFT from context_history to Original records labeled "Query by text or entry ID"; lower arrow goes LEFT TO RIGHT from Original records to context_history labeled "Original text + source ID". Ensure no arrow crosses text. Make these two arrows long enough for labels.
Footer exactly two lines: "References and verbatim quotes are checked before commit." and "Reference checks do not prove semantic completeness."
Small upper corner label "MECHANISM OVERVIEW".
All text must match exactly with no added technical claims. No speed claims, percentages, comparison claims, claims of lossless memory, or claims that native Pi deletes transcripts. No checkpoint-to-original data overwrite arrow. Text rendering must be crisp and aligned. Diagram arrows have correct directions. All elements inside generous margins.
```

### Contrast correction

```text
Edit this diagram. Keep every word, every arrow direction, card position, icon, and layout unchanged. Correct ONLY the background and contrast: replace ALL of the dark blue/black/gray blurry gradient behind the diagram with a perfectly flat pure white (#FFFFFF) opaque background. The entire canvas outside the cards must be pure solid white. No vignette, no glow, no shadows, no gradients, no texture. Keep dark navy text and arrows, pale flat teal/violet card fills. All headline text, arrow labels and the footer must be easily legible dark navy on white. White background is absolutely mandatory.
```

## Recovery example prompt

```text
Use case: infographic-diagram
Asset type: second explanatory flowchart in the Pi Context Compaction GitHub README.
Primary request: Create a clean, editorial, professional software diagram, landscape 1536x1024, easily readable at 850px display width. PURE WHITE opaque background, navy typography and arrows, pale teal and pale violet cards. Minimal flat design, generous spacing, crisp borders, simple document icons only. No gradients, no shadows, no dark background, no decoration, no robot, no terminal screenshot.
Top title exactly: "Recover the decision, not just the latest value."
Small label below title exactly: "ILLUSTRATIVE EXAMPLE — NOT A RUN CAPTURE"
Upper timeline with 3 cards left to right and arrows between:
Card 1 heading "Original diagnostic"; content "Port 9000" and "EADDRINUSE".
Card 2 heading "Earlier decision"; content "Use port 4317".
Card 3 heading "Later user ruling"; content "Use port 4318" and "Timeout 9500".
Do not imply port 4317 failed. 4318 is a later user ruling.
A thin horizontal divider below timeline.
Lower section: small label "After multiple checkpoints".
Then a full-width question box with exact text "Which port originally failed, and what did the user approve later?"
Below the question a vertical downward arrow pointing to a centered wide card: heading "context_history"; content "Read the original diagnostic and later user ruling".
Then another vertical downward arrow pointing to an answer card with two rows:
"Original failure: 9000 — EADDRINUSE"
"Current ruling: 4318 — timeout 9500"
A small footer inside answer card: "Each answer links back to its source entry."
All labels are exact. Do not fabricate entry IDs, logs, API arguments, timestamps, performance numbers, guarantees or benchmark results. No big success checkmarks. This is an educational schematic, not a screenshot. Show the two kinds of evidence as separate facts, not a fabricated causal story.
```

# Third-party notices

## Pi

This distribution is based on [earendil-works/pi](https://github.com/earendil-works/pi), tag `v0.86.0`, commit `ecac0a9c4edad3dac5d9f8b40e0c7db7a56471fc`.

Pi is MIT licensed, copyright 2025 Mario Zechner. Its original license is retained in `LICENSE`. Existing notices in source files remain in place. Dependency metadata and upstream package names identify their original authors; this repository does not publish packages under those names.

The source was imported as a clean upstream snapshot. Upstream repository automation and hooks were omitted. The upstream README, contributing guide and agent development rules are retained for reference as `UPSTREAM_README.md`, `UPSTREAM_CONTRIBUTING.md` and `UPSTREAM_AGENTS.md`; they describe upstream Pi and are not this repository's process. This repository has its own documentation and verification workflow. Context-memory runtime, tests and migration tooling are additions; six host source files are adapted to integrate them, listed with reasons in `docs/context-memory/upstream-delta.md`.

The new context-memory implementation and release tooling are copyright 2026 youxi-huang, licensed under MIT. Each dependency retains its own license; this statement does not relicense dependencies.

## Related work and development tools

- OpenAI's publicly described cross-window notes and history retrieval informed the design. Codex assisted implementation. This project does not distribute OpenAI's implementation and is not endorsed by OpenAI.
- Pi's extension APIs, session format and compaction lifecycle provide the host foundation.
- Work with `@narumitw/pi-btw`, `@tintinweb/pi-subagents` and `@narumitw/pi-codex-compact` informed integration and compatibility checks. Their locally adapted packages are not included in this release.

The upstream snapshot includes its own examples and third-party resources. Their notices are preserved. Independently installed provider and extension packages remain separate projects.

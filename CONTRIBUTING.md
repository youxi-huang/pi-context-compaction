# Contributing

Report issues and propose changes in this repository. Include the build ID, platform, a synthetic reproduction and the observed failure. Remove credentials, session content and identifying local paths from logs before sharing them.

Keep memory policy in `packages/coding-agent/src/extensions/context-memory/`. Host changes should explain why the extension layer cannot enforce the behavior itself. Do not add a second history database or silently substitute a writer on failure.

After changes, build with the pinned model data and run `node scripts/context-memory-check.mjs`. Add focused regressions for persistence, authorization or lifecycle changes. Do not run live tests with someone else's credentials. Distinguish simulated responses from provider runs.

AI-assisted contributions are welcome when the contributor can explain and maintain the change. Do not upload private prompts, production session logs or authentication files as fixtures.

Upstream Pi has separate requirements, preserved in [UPSTREAM_CONTRIBUTING.md](UPSTREAM_CONTRIBUTING.md). This repository does not grant permission to bypass those requirements.

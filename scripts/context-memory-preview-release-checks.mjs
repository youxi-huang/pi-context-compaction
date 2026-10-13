import assert from "node:assert/strict";
import { PROFILE, VERSION } from "./context-memory-preview-acceptance-profile.mjs";

/** Only reviewed stable or numbered preview spellings; never normalize source refs. */
export function parseReviewedVersion(version) {
	assert.equal(typeof version, "string", "Expected a reviewed release version");
	const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-preview\.([1-9][0-9]*))?$/.exec(version);
	assert(match && match[0] === version, "Expected a reviewed release version");
	return Object.freeze({
		version,
		preview: match[4] !== undefined,
		previewNumber: match[4] ?? null,
		tag: `v${version}`,
		packageTag: `extension-v${version}`,
	});
}

export function selectReviewedSourceTag({ requestedTag, triggerRef }) {
	assert(requestedTag === undefined || typeof requestedTag === "string", "Expected an existing source tag");
	assert(triggerRef === undefined || typeof triggerRef === "string", "Expected an existing source ref");
	const tag = requestedTag || (triggerRef?.startsWith("release/publish-")
		? triggerRef.slice("release/publish-".length) : triggerRef);
	assert(typeof tag === "string" && tag.startsWith("v"), "Expected an existing reviewed source tag");
	return parseReviewedVersion(tag.slice(1)).tag;
}

export function assertFinalMainWorkflows(runs, sourceCommit) {
	for (const path of [".github/workflows/context-memory.yml", "dynamic/github-code-scanning/codeql"]) {
		assert(runs.some((run) => run.head_sha === sourceCommit && run.head_branch === "main"
			&& run.path === path && run.status === "completed" && run.conclusion === "success"
			&& (path !== ".github/workflows/context-memory.yml" || run.event === "push")),
		`Final main workflow has not passed: ${path}`);
	}
}

// The publication workflow copies only this module and the release script, so notes live here.
export function releaseNotes({ repository, branch, tag, packageTag, sourceCommit, build, acceptanceChecks, changes, scenarioAcceptance }) {
	const reviewed = parseReviewedVersion(tag.slice(1));
	assert.equal(tag, reviewed.tag, "Expected an existing reviewed source tag");
	assert.equal(packageTag, reviewed.packageTag, "Package tag must match the source version");
	const functionalPreview = reviewed.version === VERSION;
	if (functionalPreview) assertFunctionalProfile(scenarioAcceptance);
	const introduction = reviewed.preview
		? `Pi Context Compaction ${tag} is an **experimental A-stage preview candidate** for **unmodified official Pi 1.1.0**.\n\n`
		: `Pi Context Compaction ${tag} supplies an ordinary extension for **unmodified official Pi 1.1.0**.\n\n`;
	const preparation = reviewed.preview
		? `A adds opt-in preparation using the same configured writer; it is **disabled by default**. The existing commit and failure gates remain in force. B, the new instruction-authority protocol and the full A/B comparison are incomplete and deferred. Improvements in foreground pause, total cost or recovery have not been established.\n\n`
		: "";
	const validation = functionalPreview
		? `Package/lifecycle validation: ${acceptanceChecks} stock-Pi checks passed on official Pi 1.1.0. The maintainer-approved \`${PROFILE}\` profile applies **only to v${VERSION}**. Only true failures of \`per-request-budget\` (50 ms) and \`checkpoint-overhead-growth-required\` are accepted as functional A-preview scope exceptions; correctness, security, persistence, identity, package and source checks must pass. Raw scenario gate: ${scenarioAcceptance.rawPassed ? "passed" : "failed"}. Declared raw performance exceptions: ${scenarioAcceptance.exceptions.map((entry) => `\`${entry.id}\` (${entry.status})`).join(", ") || "none"}. These are scope exceptions, not performance passes; the full v0.4.0 gates are unchanged. Focused, security, evaluator and scenario results are in the validation record. Services are synthetic and loopback only; no real-provider quality, latency or interactive TUI claim is made.\n\n`
		: reviewed.preview
		? `Package/lifecycle validation: ${acceptanceChecks} stock-Pi checks passed on official Pi 1.1.0. These checks do not establish performance acceptance. The required growth check currently fails, and the 50 ms per-request target remains unmet. Neither check is waived. Focused, security, evaluator and scenario results are in the validation record. Services are synthetic and loopback only; no real-provider quality, latency or interactive TUI claim is made.\n\n`
		: `Validation: this publication run passed ${acceptanceChecks} stock-Pi package and lifecycle checks on official Pi 1.1.0. Focused, security, evaluator and scenario results, with remaining known gaps, are in the validation record. Services are synthetic and loopback only. No real-provider quality, latency or interactive TUI claim is made.\n\n`;
	const resident = reviewed.preview
		? "Resident release version remains v0.3.0; shared-validation source identity and frozen comparison are tracked separately."
		: "Resident runtime keeps its v0.3.0 fingerprint.";
	return introduction
		+ `Install this release's extension package (a fixed package tag) from your terminal, then restart Pi:\n\n\`\`\`sh\npi install git:github.com/${repository}@${packageTag}\n\`\`\`\n\n`
		+ `Start a new persistent text session and run \`/compaction-doctor\` to check it without calling a model. Source tag \`${tag}\` selects the development monorepo, not the package. To follow later previews instead, install the moving \`${branch}\` branch in place of the tag and update only this package with \`pi update --extension git:github.com/${repository}@${branch}\`. A plain \`pi update\` updates Pi itself.\n\n`
		+ `This pre-release supports manual compaction of completed text turns, source-linked history retrieval and explicit disk-confirmed failure recovery. In the sessions it handles, automatic compaction is cancelled and ${reviewed.preview ? "Pi's built-in background cache warming" : "background cache warming"} is paused. Sessions it never protected and cannot check, such as ones with native checkpoints, images or another Pi version, are left to Pi without a failure marker. Other checkpoint formats, parent-history grants, attachments, concurrent writers and Windows are outside its verified scope.\n\n`
		+ `Ordinary Agent retries after transient provider failures are supported, including partial-response connection drops. Existing retry-related blocks and text-only context-overflow failures can use explicit /compact recovery when sufficient completed source history exists. Arbitrary context edits and unfinished tool-call omissions remain unsupported.\n\n`
		+ preparation
		+ validation
		+ `Source commit: ${sourceCommit}. Preview runtime: \`${build}\`. ${resident}\n\n`
		+ `[Usage and recovery](https://github.com/${repository}/blob/${tag}/docs/context-memory/extension-preview.md) · [Validation](https://github.com/${repository}/blob/${tag}/docs/context-memory/validation.md)\n\n`
		+ `### Changes\n${changes}\n`;
}

/**
 * Copyable commands stay unambiguous: the first block installs the fixed package tag alone, no block
 * holds more than one Pi command, and the moving branch never shares a block with the fixed tag.
 */
function assertFunctionalProfile(value) {
	assert.equal(value?.profile, PROFILE, "This preview requires its authorized acceptance profile");
	assert.equal(value.version, VERSION, "The acceptance profile cannot apply to another version");
	assert.equal(value.accepted, true, "The acceptance profile must pass all non-excepted gates");
	assert.equal(typeof value.rawPassed, "boolean", "The raw scenario outcome must remain visible");
	assert(Array.isArray(value.exceptions), "The acceptance profile must declare its raw exceptions");
}

export function assertReleaseNotes(notes, { repository, packageTag, branch, scenarioAcceptance }) {
	assert(packageTag.startsWith("extension-v"), "Expected a reviewed fixed package tag");
	const reviewed = parseReviewedVersion(packageTag.slice("extension-v".length));
	if (reviewed.version === VERSION) {
		assertFunctionalProfile(scenarioAcceptance);
		assert(notes.includes(`\`${PROFILE}\` profile applies **only to v${VERSION}**`), "Preview notes must name the version-bound authorization");
		assert(notes.includes("correctness, security, persistence, identity, package and source checks must pass"), "Preview notes must retain every other gate");
		assert(notes.includes(`Raw scenario gate: ${scenarioAcceptance.rawPassed ? "passed" : "failed"}.`), "Preview notes must preserve the raw scenario outcome");
		assert(notes.includes("scope exceptions, not performance passes; the full v0.4.0 gates are unchanged"), "Preview notes must not promote scope exceptions to full-version acceptance");
		assert(notes.includes("Improvements in foreground pause, total cost or recovery have not been established"), "Preview notes must not claim unmeasured benefits");
		for (const entry of scenarioAcceptance.exceptions) assert(notes.includes(`\`${entry.id}\` (${entry.status})`), "Preview notes must disclose each raw performance exception");
	}
	const blocks = [...notes.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((match) => match[1].trim());
	assert(blocks.length > 0, "Release notes need a copyable install command");
	assert.equal(blocks[0], `pi install git:github.com/${repository}@${packageTag}`, "The first block must install the fixed package tag alone");
	for (const block of blocks) {
		const commands = block.split("\n").filter((line) => /^pi\s/.test(line.trim()));
		assert(commands.length <= 1, "Each copyable block may hold one Pi command");
		assert(!(block.includes(`@${packageTag}`) && block.includes(`@${branch}`)), "A fixed tag and the moving branch must not share a block");
	}
}

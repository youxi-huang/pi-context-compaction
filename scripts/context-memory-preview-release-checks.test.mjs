import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import { assertFinalMainWorkflows, assertReleaseNotes, parseReviewedVersion, releaseNotes, selectReviewedSourceTag } from "./context-memory-preview-release-checks.mjs";
import { PROFILE, VERSION } from "./context-memory-preview-acceptance-profile.mjs";

test("reviewed versions retain exact stable and positive numbered-preview spellings", () => {
	for (const version of ["0.3.3", "0.4.0-preview.1", "12.34.56-preview.123", "0.0.0"]) {
		const parsed = parseReviewedVersion(version);
		assert.equal(parsed.version, version);
		assert.equal(parsed.tag, `v${version}`);
		assert.equal(parsed.packageTag, `extension-v${version}`);
		assert.equal(parsed.preview, version.includes("-preview."));
		assert.equal(parsed.previewNumber, version.split("-preview.")[1] ?? null);
		assert(Object.isFrozen(parsed));
	}
});

test("unreviewed suffixes, noncanonical counters and lossy version spellings are rejected", () => {
	for (const version of [
		undefined, null, 4, "", "v0.4.0", "0.4", "0.4.0-preview", "0.4.0-preview.0", "0.4.0-preview.01",
		"0.4.0-preview.-1", "0.4.0-preview.+1", "0.4.0-preview.1.0", "0.4.0-preview.1-extra",
		"0.4.0-alpha.1", "0.4.0-rc.1", "0.4.0-preview.1+build", "0.4.0+build", "00.4.0", "0.04.0", "0.4.00",
		" 0.4.0", "0.4.0 ", "0.4.0\n", "0.4.0-preview.1\r\n", "0.4.0-preview.1\u0000",
	]) assert.throws(() => parseReviewedVersion(version), /Expected a reviewed release version/);
});

test("source selection accepts only exact reviewed existing source-tag forms", () => {
	for (const tag of ["v0.3.3", "v0.4.0-preview.1"]) {
		assert.equal(selectReviewedSourceTag({ triggerRef: tag }), tag);
		assert.equal(selectReviewedSourceTag({ requestedTag: "", triggerRef: `release/publish-${tag}` }), tag);
		assert.equal(selectReviewedSourceTag({ requestedTag: tag, triggerRef: "main" }), tag);
	}
	for (const triggerRef of [undefined, "main", "extension-v0.4.0-preview.1", "refs/tags/v0.4.0-preview.1", "release/publish-release/publish-v0.4.0-preview.1", "release/publish-v0.4.0-preview.0", "v0.4.0-preview.1\n"]) {
		assert.throws(() => selectReviewedSourceTag({ triggerRef }));
	}
	for (const requestedTag of ["release/publish-v0.4.0-preview.1", "v0.4.0-rc.1", " v0.3.3", 4]) {
		assert.throws(() => selectReviewedSourceTag({ requestedTag, triggerRef: "v0.3.3" }));
	}
});

test("publication workflow uses the same source selector and preserved eight-component installer", () => {
	const document = parseDocument(readFileSync(new URL("../.github/workflows/context-memory-preview-release.yml", import.meta.url), "utf8"));
	assert.deepEqual(document.errors, []);
	const steps = document.toJS().jobs.publish.steps;
	const selector = steps.find((step) => step.id === "source");
	const selection = selector.run.slice(0, selector.run.indexOf("git fetch origin main"));
	assert.match(selection, /selectReviewedSourceTag/);
	assert.match(selector.run, /context-memory-preview-stock-install\.mjs.*context-preview-publisher\/scripts\//);
	assert.match(selector.run, /cp eval\/deny-network\.mjs.*context-preview-publisher\/eval\//);
	assert.match(selector.run, /context-memory-preview-acceptance-profile\.mjs/);
	const cwd = fileURLToPath(new URL("../", import.meta.url));
	for (const [ref, accepted] of [["v0.3.3", true], ["release/publish-v0.4.0-preview.1", true], ["v0.4.0-preview.0", false], ["v0.4.0-preview.1\n", false], ["v0.4.0-rc.1", false]]) {
		const result = spawnSync("bash", ["-e", "-c", `${selection}\nprintf '%s' "$selected_tag"`], {
			cwd, encoding: "utf8", env: { ...process.env, PI_CONTEXT_REQUESTED_TAG: "", PI_CONTEXT_TRIGGER_REF: ref },
		});
		assert.equal(result.status === 0, accepted, ref);
		if (accepted) assert.equal(result.stdout, selectReviewedSourceTag({ triggerRef: ref }));
	}
	const install = steps.find((step) => step.name === "Install official Pi baseline");
	assert.match(install.run, /context-preview-publisher\/scripts\/context-memory-preview-stock-install\.mjs/);
	assert.match(install.run, /--version 1\.1\.0/);
	assert.doesNotMatch(install.run, /npm install/);
	const publish = steps.find((step) => step.name === "Publish checked package and source archives");
	assert.match(publish.run, /context-preview-publisher\/scripts\/context-memory-preview-release\.mjs" --publish/);
	const scope = steps.find((step) => step.name === "Verify the explicitly authorized A-preview scope");
	assert.match(scope.run, /if \[ "\$candidate_version" = "0\.4\.0-preview\.1" \]/);
	assert.match(scope.run, /--acceptance-profile v0\.4\.0-preview\.1-a-functional/);
	assert.match(scope.run, /--version 1\.0\.4/);
});

test("main CI selects the exact functional-preview profile without removing other gates", () => {
	const document = parseDocument(readFileSync(new URL("../.github/workflows/context-memory.yml", import.meta.url), "utf8"));
	assert.deepEqual(document.errors, []);
	const runs = document.toJS().jobs.verify.steps.flatMap((step) => step.run ? [step.run] : []);
	assert(runs.some((run) => run.includes("context-memory-preview-scenarios.mjs") && run.includes(`--acceptance-profile ${PROFILE}`)));
	for (const required of ["context-memory-check.mjs", "security-regression-check.mjs", "context-memory-preview-acceptance.mjs", "context-memory-preview-release.mjs --prepare", "eval/check.mjs"]) {
		assert(runs.some((run) => run.includes(required)), `Missing CI gate: ${required}`);
	}
});

test("ops rejects ambiguous or misplaced acceptance-profile flags before running a pipeline", () => {
	const script = fileURLToPath(new URL("./context-memory-ops.mjs", import.meta.url));
	for (const args of [["verify", "--acceptance-profile", PROFILE], ["preview", "--acceptance-profile"], ["ci", "--acceptance-profile", "unapproved"], ["ci", "--acceptance-profile", PROFILE, "--acceptance-profile", PROFILE]]) {
		const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
		assert.equal(result.status, 2);
		assert.doesNotMatch(result.stdout, /^== /m);
	}
});

const sourceCommit = "534c8994ed17539ac97ed5712c36efe01268dffb";
// GitHub's default CodeQL setup reports event=dynamic, including scans of main.
const mainRuns = [
	{ head_sha: sourceCommit, head_branch: "main", path: ".github/workflows/context-memory.yml", event: "push", status: "completed", conclusion: "success" },
	{ head_sha: sourceCommit, head_branch: "main", path: "dynamic/github-code-scanning/codeql", event: "dynamic", status: "completed", conclusion: "success" },
];

test("completed default CodeQL and push verification both satisfy the release gate", () => {
	assert.doesNotThrow(() => assertFinalMainWorkflows(mainRuns, sourceCommit));
});

test("a scan of another source commit, tag or workflow cannot replace the main scan", () => {
	for (const replacement of [{ head_sha: "0".repeat(40) }, { head_branch: "v0.3.1" }, { path: ".github/workflows/another.yml" }]) {
		assert.throws(() => assertFinalMainWorkflows([mainRuns[0], { ...mainRuns[1], ...replacement }], sourceCommit));
	}
});

test("a missing, failed or unfinished main workflow blocks publication", () => {
	for (const index of [0, 1]) {
		assert.throws(() => assertFinalMainWorkflows(mainRuns.filter((_, i) => i !== index), sourceCommit));
		for (const replacement of [{ status: "in_progress", conclusion: null }, { conclusion: "failure" }]) {
			assert.throws(() => assertFinalMainWorkflows(mainRuns.map((run, i) => i === index ? { ...run, ...replacement } : run), sourceCommit));
		}
	}
});

test("manual verification cannot replace the final main push verification", () => {
	assert.throws(() => assertFinalMainWorkflows([{ ...mainRuns[0], event: "workflow_dispatch" }, mainRuns[1]], sourceCommit));
});

const repository = "youxi-huang/pi-context-compaction";
const noteOptions = { repository, packageTag: "extension-v0.3.3", branch: "extension-preview" };
const scenarioAcceptance = { profile: PROFILE, version: VERSION, accepted: true, rawPassed: false, exceptions: [
	{ id: "long-session-overhead/per-request-budget", status: "known-gap", criterion: "per-request-budget", pi: "1.1.0" },
	{ id: "long-session-overhead/bounded-growth", status: "fail", criterion: "checkpoint-overhead-growth-required", pi: "1.1.0" },
] };
const notes = releaseNotes({ ...noteOptions, tag: "v0.3.3", sourceCommit, build: "stock-preview+src.0000000000000000", acceptanceChecks: 27, changes: "### Fixed\n\n- Synthetic entry." });

test("generated release notes install the fixed package tag alone in their first block", () => {
	assert.doesNotThrow(() => assertReleaseNotes(notes, noteOptions));
	assert.match(notes, /```sh\npi install git:github\.com\/youxi-huang\/pi-context-compaction@extension-v0\.3\.3\n```/);
	assert.doesNotMatch(notes, /147 context checks|83 scenario checks/);
	assert.match(notes, /Resident runtime keeps its v0\.3\.0 fingerprint/);
	assert.doesNotMatch(notes, /experimental A-stage|full A\/B comparison/);
});

test("numbered previews disclose deferred scope and failed performance without claiming benefits", () => {
	const previewOptions = { ...noteOptions, packageTag: "extension-v0.4.0-preview.1" };
	const previewNotes = releaseNotes({ ...previewOptions, tag: "v0.4.0-preview.1", sourceCommit, build: "stock-preview+src.0000000000000000", acceptanceChecks: 27, changes: "### Added\n\n- Synthetic A-stage candidate.", scenarioAcceptance });
	assert.doesNotThrow(() => assertReleaseNotes(previewNotes, { ...previewOptions, scenarioAcceptance }));
	assert.match(previewNotes, /\*\*experimental A-stage preview candidate\*\*/);
	assert.match(previewNotes, /opt-in preparation using the same configured writer; it is \*\*disabled by default\*\*/);
	assert.match(previewNotes, /B, the new instruction-authority protocol and the full A\/B comparison are incomplete and deferred/);
	assert.match(previewNotes, /Improvements in foreground pause, total cost or recovery have not been established/);
	assert.match(previewNotes, /profile applies \*\*only to v0\.4\.0-preview\.1\*\*/);
	assert.match(previewNotes, /Raw scenario gate: failed/);
	assert.match(previewNotes, /long-session-overhead\/bounded-growth` \(fail\)/);
	assert.match(previewNotes, /long-session-overhead\/per-request-budget` \(known-gap\)/);
	assert.match(previewNotes, /full v0\.4\.0 gates are unchanged/);
	assert.match(previewNotes, /Pi's built-in background cache warming/);
	assert.match(previewNotes, /Resident release version remains v0\.3\.0; shared-validation source identity and frozen comparison are tracked separately/);
	assert.doesNotMatch(previewNotes, /Resident runtime keeps its v0\.3\.0 fingerprint|growth check (?:has )?passed|50 ms per-request target (?:has )?passed/);
});

test("functional-preview notes require the authorized profile and every raw-exception disclosure", () => {
	const options = { ...noteOptions, tag: `v${VERSION}`, packageTag: `extension-v${VERSION}`, sourceCommit, build: "stock-preview+src.0000000000000000", acceptanceChecks: 27, changes: "Synthetic." };
	for (const invalid of [undefined, { ...scenarioAcceptance, version: "0.4.0-preview.2" }, { ...scenarioAcceptance, profile: "strict" }, { ...scenarioAcceptance, accepted: false }]) {
		assert.throws(() => releaseNotes({ ...options, scenarioAcceptance: invalid }));
	}
	const generated = releaseNotes({ ...options, scenarioAcceptance });
	for (const removed of ["Raw scenario gate: failed.", "full v0.4.0 gates are unchanged", "correctness, security, persistence, identity, package and source checks must pass", "`long-session-overhead/bounded-growth` (fail)"]) {
		assert.throws(() => assertReleaseNotes(generated.replace(removed, ""), { ...options, scenarioAcceptance }));
	}
});

test("release notes reject mismatched or unreviewed source and package tags", () => {
	assert.throws(() => releaseNotes({ ...noteOptions, tag: "v0.4.0-preview.0" }));
	assert.throws(() => releaseNotes({ ...noteOptions, tag: "v0.4.0-preview.1" }));
	assert.throws(() => releaseNotes({ ...noteOptions, tag: "release/publish-v0.3.3" }));
});

test("install, update and remove commands may not share a copyable block", () => {
	const combined = "```sh\npi install git:github.com/youxi-huang/pi-context-compaction@extension-v0.3.3\npi update --extension git:github.com/youxi-huang/pi-context-compaction@extension-preview\n```\n";
	assert.throws(() => assertReleaseNotes(combined, noteOptions));
});

test("the first copyable block may not install the moving branch", () => {
	const moving = "```sh\npi install git:github.com/youxi-huang/pi-context-compaction@extension-preview\n```\n";
	assert.throws(() => assertReleaseNotes(moving, noteOptions));
});

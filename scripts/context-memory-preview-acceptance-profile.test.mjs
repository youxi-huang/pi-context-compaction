import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PROFILE, VERSION, assertProfileVersion, assertScenarioAcceptance, gradeScenarioAcceptance } from "./context-memory-preview-acceptance-profile.mjs";

const BUDGET = "long-session-overhead/per-request-budget";
const GROWTH = "long-session-overhead/bounded-growth";
const candidate = {
	version: "0.4.0-preview.1", sourceCommit: "a".repeat(40), build: `stock-preview+src.${"1".repeat(16)}`,
	sourceHash: "1".repeat(64), manifestHash: "2".repeat(64), entryHash: "3".repeat(64), buildMetadataHash: "4".repeat(64),
};

// Independent synthetic report fixture: no runtime, session content, host installation or model call.
const CASES = [
	["documented-first-compaction", "ready-notice one-open-notice doctor-read-only doctor-separates-checks doctor-eligibility-unknown recover-harmless recover-not-circular status-compatible short-compact-harmless extension-checkpoint history-readable next-prompt-sent reopen-usable"],
	["invalid-config", "fails-closed no-marker one-notice usable-after-fix"],
	["provider-retry", "seeded retry-completes no-marker manual-compact-succeeds history-readable next-prompt-sent reload-usable reopen-usable no-omitted-assistant", "retry-completes context-edit-written"],
	["provider-connection-drop", "seeded retry-completes no-marker manual-compact-succeeds history-readable next-prompt-sent reload-usable reopen-usable no-omitted-assistant", "retry-completes context-edit-written"],
	["provider-partial-drop", "seeded retry-completes no-marker partial-reply-recorded manual-compact-succeeds history-readable next-prompt-sent reload-usable reopen-usable no-omitted-assistant", "retry-completes context-edit-written"],
	["provider-repeated-retry", "seeded retry-completes no-marker manual-compact-succeeds history-readable next-prompt-sent reload-usable reopen-usable no-omitted-assistant", "retry-completes context-edit-written"],
	["provider-first-turn-retry", "retry-completes no-marker next-prompt-sent reload-usable reopen-usable no-omitted-assistant", "retry-completes context-edit-written"],
	["provider-retry-exhausted", "retries-exhausted no-marker next-prompt-sent", "retries-exhausted no-marker next-prompt-sent"],
	["legacy-retry-marker", "blocked-before-retry unstaged-not-recovered explicit-retry-recovers unfinished-request-kept next-prompt-sent"],
	["context-overflow", "no-native-summary manual-compact-recovers unfinished-request-kept next-prompt-sent", "native-recovers"],
	["threshold", "no-native-summary threshold-checkpoint no-marker next-prompt-sent", "native-compacts"],
	["image-input", "text-after-image-sent no-marker notice-explains-image", "image-sent"],
	["protected-image", "fixture-protected image-blocked marker-kept one-notice notice-explains-image stays-blocked"],
	["native-checkpoint-session", "fixture-native-checkpoint no-marker-on-open one-notice-on-open prompt-sent compact-left-to-pi"],
	["enrolled-then-native", "fixture-native-checkpoint prompt-sent one-notice"],
	["protected-then-native", "fixture-protected fixture-native-checkpoint stays-blocked one-notice-per-input notice-points-to-new-session"],
	["in-memory-session", "prompt-sent", "prompt-sent"],
	["other-pi-version", "fresh-session-usable no-marker", "prompt-sent"],
	["failed-compaction-notices", "rejected-and-blocked quote-repair-refused one-notice-for-failure one-notice-per-blocked-input explicit-retry-recovers quote-repair-commits sources-repair-refused sources-repair-commits"],
	["work-notes", "guideline forged-notes-refused note-saved notes-commit disk-confirmed user-words note-claim-stays-data typed-list correction-in-context restart section-tamper-blocks explicit-recovery same-id-edit-blocks"],
	["prepared-candidate", "no-note-guideline prepared branch-switch-drops-candidate sync-on-new-branch unknown-usage cancelled-preparation journal-survives-restart"],
	["long-session-overhead", "compactions-succeed per-request-budget bounded-growth"],
];

function regradeRaw(report) {
	report.checks = [];
	report.summary = { pass: 0, gap: 0, fail: 0, nowPasses: 0, skipped: 0 };
	for (const result of report.cases) {
		if (result.skipped) {
			report.summary.skipped++;
			continue;
		}
		for (const raw of result.checks) {
			const id = `${result.case}${result.variant === "control" ? ":control" : ""}/${raw.key}`;
			const gap = report.knownGaps.includes(id);
			const status = raw.passed ? (gap ? "now-passes" : "pass") : gap ? "known-gap" : "fail";
			report.checks.push({ id, description: raw.description, status, pi: result.pi });
			report.summary[{ pass: "pass", "known-gap": "gap", fail: "fail", "now-passes": "nowPasses" }[status]]++;
		}
	}
	report.passed = report.summary.fail === 0 && report.summary.nowPasses === 0;
	return report;
}

function fixture({ allPass = false } = {}) {
	return regradeRaw({
		candidate: { ...candidate },
		scope: { only: null, checkpointTarget: 20, otherHostVersion: "1.0.4" },
		knownGaps: allPass ? [] : [BUDGET],
		cases: CASES.flatMap(([name, extension, control]) => [
			["extension", extension], ...(control === undefined ? [] : [["control", control]]),
		].map(([variant, keys]) => ({
			case: name, variant, pi: name === "other-pi-version" ? "1.0.4" : "1.1.0",
			checks: keys.split(" ").map((key) => ({ key, description: `Synthetic assertion ${name}/${key}`, passed: allPass || ![BUDGET, GROWTH].includes(`${name}/${key}`) })),
		}))),
	});
}

function rawCheck(report, id) {
	for (const result of report.cases) {
		const prefix = `${result.case}${result.variant === "control" ? ":control" : ""}/`;
		if (id.startsWith(prefix)) return result.checks.find((check) => check.key === id.slice(prefix.length));
	}
	throw new Error(`Missing synthetic assertion ${id}`);
}

function publication(report, profile = PROFILE, expected = candidate, host) {
	report.acceptance = gradeScenarioAcceptance(report, profile);
	return assertScenarioAcceptance(report, { profile, candidate: expected, ...(host === undefined ? {} : { host }) });
}

test("reviewed full case matrix matches the current scenario runner", () => {
	const source = readFileSync(new URL("./context-memory-preview-scenarios.mjs", import.meta.url), "utf8");
	const declaration = /const CASES = \[([\s\S]*?)\n\];/.exec(source)?.[1];
	assert(declaration, "Expected the scenario runner's explicit case matrix");
	const actual = [...declaration.matchAll(/\{ name: "([^"]+)", variants: \[([^\]]+)\]/g)].map((match) => ({ case: match[1], variants: [...match[2].matchAll(/"([^"]+)"/g)].map((variant) => variant[1]) }));
	assert.deepEqual(actual, CASES.map(([name, , control]) => ({ case: name, variants: control === undefined ? ["extension"] : ["extension", "control"] })));
	assert.equal(fixture().cases.length, 33);
});

test("the sole authorized profile accepts two unchanged raw performance results", () => {
	assert.equal(PROFILE, "v0.4.0-preview.1-a-functional");
	assert.equal(VERSION, "0.4.0-preview.1");
	const report = fixture();
	const before = structuredClone(report);
	const grade = gradeScenarioAcceptance(report, PROFILE);
	assert.deepEqual(report, before);
	assert.equal(report.passed, false);
	assert.equal(report.summary.fail, 1);
	assert.equal(report.summary.gap, 1);
	assert.equal(grade.accepted, true);
	assert.equal(grade.rawPassed, false);
	assert.deepEqual(grade.exceptions, [
		{ id: BUDGET, status: "known-gap", criterion: "per-request-budget", pi: "1.1.0" },
		{ id: GROWTH, status: "fail", criterion: "checkpoint-overhead-growth-required", pi: "1.1.0" },
	]);
	assert(Object.isFrozen(grade));
	assert(Object.isFrozen(grade.exceptions));
	assert(Object.isFrozen(grade.exceptions[0]));
	assert(Object.isFrozen(grade.reasons));
	assert.throws(() => { grade.exceptions[0].status = "pass"; }, TypeError);
	assert.deepEqual(publication(report), grade);
	assert.equal(report.checks.find((check) => check.id === GROWTH).status, "fail");
	assert.equal(rawCheck(report, GROWTH).passed, false);
});

test("strict grading retains the existing probe behavior and never adopts the exception", () => {
	assert.equal(gradeScenarioAcceptance({ passed: true }).accepted, true);
	assert.equal(gradeScenarioAcceptance({ passed: false }).accepted, false);
	assert.equal(gradeScenarioAcceptance(fixture()).accepted, false);
	assert.throws(() => publication(fixture(), "strict", candidate, "1.1.0"), /strict scenario checks failed/);
	const partial = fixture();
	partial.scope.only = "long-session-overhead";
	partial.cases = partial.cases.filter((result) => result.case === "long-session-overhead");
	regradeRaw(partial);
	assert.equal(gradeScenarioAcceptance(partial, PROFILE).accepted, false);
});

for (const version of ["0.4.0", "0.4.0-preview.2", "0.3.3", "v0.4.0-preview.1", "0.4.0-preview.1\n"]) {
	test(`the functional exception is denied for ${JSON.stringify(version)}`, () => {
		assert.throws(() => assertProfileVersion(PROFILE, version), /authorized only/);
		const report = fixture();
		report.candidate.version = version;
		assert.equal(gradeScenarioAcceptance(report, PROFILE).accepted, false);
		assert.throws(() => publication(report, PROFILE, { ...candidate, version }));
	});
}

test("unknown profiles are denied before workers and during grading/publication", () => {
	assert.throws(() => assertProfileVersion("a-functional", VERSION), /Unknown scenario acceptance profile/);
	assert.equal(gradeScenarioAcceptance(fixture(), "a-functional").accepted, false);
	assert.throws(() => publication(fixture(), "a-functional"));
	assert.doesNotThrow(() => assertProfileVersion("strict", "0.3.3"));
});

test("both profiles accept genuinely required all-pass reports without stale known gaps", () => {
	for (const profile of ["strict", PROFILE]) {
		const report = fixture({ allPass: true });
		const grade = publication(report, profile, candidate, "1.1.0");
		assert.equal(grade.accepted, true);
		assert.equal(grade.rawPassed, true);
		assert.deepEqual(grade.exceptions, []);
	}
});

test("a passing required growth check leaves only the budget known gap", () => {
	const report = fixture();
	rawCheck(report, GROWTH).passed = true;
	regradeRaw(report);
	assert.equal(report.passed, true);
	assert.deepEqual(publication(report).exceptions.map((exception) => exception.id), [BUDGET]);
});

test("a listed known gap that now passes remains a failure", () => {
	const report = fixture();
	rawCheck(report, BUDGET).passed = true;
	regradeRaw(report);
	assert.equal(report.checks.find((check) => check.id === BUDGET).status, "now-passes");
	assert.equal(gradeScenarioAcceptance(report, PROFILE).accepted, false);
	assert.throws(() => publication(report));
});

for (const id of [
	"documented-first-compaction/extension-checkpoint", "documented-first-compaction/history-readable",
	"documented-first-compaction/reopen-usable", "invalid-config/fails-closed",
	"failed-compaction-notices/rejected-and-blocked", "legacy-retry-marker/unfinished-request-kept",
	"documented-first-compaction/harness", "long-session-overhead/compactions-succeed",
]) {
	test(`unrelated correctness/source/persistence result cannot use the exception: ${id}`, () => {
		const report = fixture();
		if (id.endsWith("/harness")) report.cases[0].checks.push({ key: "harness", description: "Synthetic harness failure", passed: false });
		else rawCheck(report, id).passed = false;
		regradeRaw(report);
		assert.equal(gradeScenarioAcceptance(report, PROFILE).accepted, false);
		assert.throws(() => publication(report));
	});
}

const corruptions = [
	["truncated raw case matrix", (report) => { report.cases.pop(); regradeRaw(report); }],
	["duplicated raw case", (report) => { report.cases[1] = structuredClone(report.cases[0]); regradeRaw(report); }],
	["unreviewed additional case", (report) => { report.cases.push({ ...structuredClone(report.cases[0]), case: "new-unreviewed-case" }); regradeRaw(report); }],
	["truncated raw and graded checks together", (report) => { report.cases[0].checks.pop(); regradeRaw(report); }],
	["duplicated raw check", (report) => { report.cases[0].checks[1] = structuredClone(report.cases[0].checks[0]); regradeRaw(report); }],
	["added unknown check", (report) => { report.cases[0].checks.push({ key: "unknown", description: "Synthetic new assertion", passed: true }); regradeRaw(report); }],
	["missing graded check", (report) => { report.checks.pop(); }],
	["extra graded check", (report) => { report.checks.push({ ...report.checks[0] }); }],
	["graded check id mismatch", (report) => { report.checks[0].id = "other/check"; }],
	["graded check description mismatch", (report) => { report.checks[0].description = "Different assertion"; }],
	["failure relabeled as pass", (report) => { report.checks.find((check) => check.id === GROWTH).status = "pass"; }],
	["raw result changed without matching grading", (report) => { rawCheck(report, GROWTH).passed = true; }],
	["nonboolean raw result", (report) => { report.cases[0].checks[0].passed = 1; }],
	["summary mismatch", (report) => { report.summary.fail = 0; }],
	["missing summary count", (report) => { delete report.summary.skipped; }],
	["strict passed overwritten by acceptance", (report) => { report.passed = true; }],
	["raw host identity mismatch", (report) => { report.cases[0].pi = "patched-host"; regradeRaw(report); }],
	["graded host identity mismatch", (report) => { report.checks[0].pi = "1.0.4"; }],
	["other host missing", (report) => { report.scope.otherHostVersion = null; }],
	["other host unreviewed", (report) => { report.scope.otherHostVersion = "1.0.5"; }],
	["wrong checkpoint target", (report) => { report.scope.checkpointTarget = 10; }],
	["partial run", (report) => { report.scope.only = "long-session-overhead"; }],
	["skipped variant", (report) => { report.cases[0].skipped = "Synthetic skip"; regradeRaw(report); }],
	["unknown known gap", (report) => { report.knownGaps.push(GROWTH); regradeRaw(report); }],
	["duplicate known gap", (report) => { report.knownGaps.push(BUDGET); regradeRaw(report); }],
	["budget failure not a recorded known gap", (report) => { report.knownGaps = []; regradeRaw(report); }],
];

for (const [label, corrupt] of corruptions) {
	test(`publication rejects ${label} while retaining the raw report`, () => {
		const report = fixture();
		corrupt(report);
		const before = structuredClone(report);
		assert.equal(gradeScenarioAcceptance(report, PROFILE).accepted, false);
		assert.deepEqual(report, before);
		assert.throws(() => publication(report));
	});
}

test("strict publication validates full raw evidence even when the probe passed flag is true", () => {
	for (const label of [
		"truncated raw case matrix", "truncated raw and graded checks together", "duplicated raw check",
		"missing graded check", "extra graded check", "graded check id mismatch", "nonboolean raw result",
		"missing summary count", "raw host identity mismatch", "other host missing", "wrong checkpoint target",
		"partial run", "skipped variant", "unknown known gap",
	]) {
		const strict = fixture({ allPass: true });
		corruptions.find(([name]) => name === label)[1](strict);
		strict.passed = true;
		assert.equal(gradeScenarioAcceptance(strict).accepted, true);
		assert.throws(() => publication(strict, "strict", candidate, "1.1.0"), label);
	}
});

for (const key of Object.keys(candidate)) {
	test(`publication binds candidate ${key}`, () => {
		const report = fixture();
		const other = { ...candidate, [key]: key === "version" ? "0.3.3" : key === "build" ? "stock-preview+src.mismatch" : "b".repeat(key === "sourceCommit" ? 40 : 64) };
		assert.throws(() => publication(report, PROFILE, other));
	});

	test(`functional grading rejects missing candidate ${key}`, () => {
		const report = fixture();
		delete report.candidate[key];
		assert.equal(gradeScenarioAcceptance(report, PROFILE).accepted, false);
		assert.throws(() => publication(report));
	});
}

test("a locally uncommitted candidate can be graded but cannot replace final publication identity", () => {
	const report = fixture();
	report.candidate.sourceCommit = null;
	assert.equal(gradeScenarioAcceptance(report, PROFILE).accepted, true);
	assert.throws(() => publication(report), /sourceCommit does not match publication/);
	assert.throws(() => publication(report, PROFILE, { ...candidate, sourceCommit: null }), /final source commit/);
});

test("candidate hash syntax and build/source consistency cannot be bypassed", () => {
	for (const update of [
		{ sourceHash: "F".repeat(64) }, { entryHash: `${"3".repeat(64)}\n` }, { entryHash: `${"3".repeat(63)}\n` }, { manifestHash: "2".repeat(63) },
		{ sourceCommit: "a".repeat(39) }, { sourceCommit: `${"a".repeat(39)}\n` }, { buildMetadataHash: null }, { build: "stock-preview+src.mismatch" },
	]) {
		const report = fixture();
		Object.assign(report.candidate, update);
		assert.equal(gradeScenarioAcceptance(report, PROFILE).accepted, false);
		assert.throws(() => publication(report));
	}
});

test("strict publication requires the full scenario evidence on the candidate's primary host", () => {
	for (const [version, host] of [["0.4.2", "1.2.0"], ["0.4.3", "1.3.0"]]) {
		const report = fixture({ allPass: true });
		report.candidate.version = version;
		const expected = { ...report.candidate };
		assert.throws(() => publication(report, "strict", expected, host), /reviewed official Pi version/);
		for (const result of report.cases) if (result.case !== "other-pi-version") result.pi = host;
		regradeRaw(report);
		assert.doesNotThrow(() => publication(report, "strict", expected, host));
		assert.throws(() => publication(report, "strict", expected), /primary official Pi version/);
		assert.throws(() => publication(report, "strict", expected, "1.0.4"), /primary official Pi version/);
		report.cases[0].pi = `${host}1`;
		regradeRaw(report);
		assert.throws(() => publication(report, "strict", expected, host), /reviewed official Pi version/);
	}
});

test("the functional profile cannot be re-pointed at another host", () => {
	const report = fixture();
	report.acceptance = gradeScenarioAcceptance(report, PROFILE);
	assert.throws(() => assertScenarioAcceptance(report, { profile: PROFILE, candidate, host: "1.2.0" }), /authorized only on official Pi 1\.1\.0/);
});

test("publication recomputes acceptance rather than trusting a recorded approval", () => {
	for (const mutate of [
		(report) => { delete report.acceptance; },
		(report) => { report.acceptance.accepted = false; },
		(report) => { report.acceptance.rawPassed = true; },
		(report) => { report.acceptance.profile = "strict"; },
		(report) => { report.acceptance.exceptions[1].status = "pass"; },
		(report) => { report.acceptance.exceptions = []; },
		(report) => { report.acceptance.reasons = ["Unrecorded policy"]; },
	]) {
		const report = fixture();
		report.acceptance = structuredClone(gradeScenarioAcceptance(report, PROFILE));
		mutate(report);
		assert.throws(() => assertScenarioAcceptance(report, { profile: PROFILE, candidate }), /Recorded scenario acceptance/);
	}
});

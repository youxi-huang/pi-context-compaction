import assert from "node:assert/strict";

export const PROFILE = "v0.4.0-preview.1-a-functional";
export const VERSION = "0.4.0-preview.1";

const BUDGET = "long-session-overhead/per-request-budget";
const GROWTH = "long-session-overhead/bounded-growth";
const CANDIDATE_FIELDS = ["version", "sourceCommit", "build", "sourceHash", "manifestHash", "entryHash", "buildMetadataHash"];
const SUMMARY_FIELDS = ["pass", "gap", "fail", "nowPasses", "skipped"];
const retry = "seeded retry-completes no-marker manual-compact-succeeds history-readable next-prompt-sent reload-usable reopen-usable no-omitted-assistant";
const controlRetry = "retry-completes context-edit-written";
const exhausted = "retries-exhausted no-marker next-prompt-sent";

function scenario(name, extension, control) {
	return { name, variants: [{ variant: "extension", keys: extension.split(" ") }, ...(control === undefined ? [] : [{ variant: "control", keys: control.split(" ") }])] };
}

// This is the reviewed full-suite contract, including each raw assertion. Adding or removing a
// scenario/assertion requires reviewing this contract too; truncating both report layers cannot pass.
const SCENARIOS = [
	scenario("documented-first-compaction", "ready-notice one-open-notice doctor-read-only doctor-separates-checks doctor-eligibility-unknown recover-harmless recover-not-circular status-compatible short-compact-harmless extension-checkpoint history-readable next-prompt-sent reopen-usable"),
	scenario("invalid-config", "fails-closed no-marker one-notice usable-after-fix"),
	scenario("provider-retry", retry, controlRetry),
	scenario("provider-connection-drop", retry, controlRetry),
	scenario("provider-partial-drop", retry.replace("no-marker", "no-marker partial-reply-recorded"), controlRetry),
	scenario("provider-repeated-retry", retry, controlRetry),
	scenario("provider-first-turn-retry", "retry-completes no-marker next-prompt-sent reload-usable reopen-usable no-omitted-assistant", controlRetry),
	scenario("provider-retry-exhausted", exhausted, exhausted),
	scenario("legacy-retry-marker", "blocked-before-retry unstaged-not-recovered explicit-retry-recovers unfinished-request-kept next-prompt-sent"),
	scenario("context-overflow", "no-native-summary manual-compact-recovers unfinished-request-kept next-prompt-sent", "native-recovers"),
	scenario("threshold", "no-native-summary threshold-checkpoint no-marker next-prompt-sent", "native-compacts"),
	scenario("image-input", "text-after-image-sent no-marker notice-explains-image", "image-sent"),
	scenario("protected-image", "fixture-protected image-blocked marker-kept one-notice notice-explains-image stays-blocked"),
	scenario("native-checkpoint-session", "fixture-native-checkpoint no-marker-on-open one-notice-on-open prompt-sent compact-left-to-pi"),
	scenario("enrolled-then-native", "fixture-native-checkpoint prompt-sent one-notice"),
	scenario("protected-then-native", "fixture-protected fixture-native-checkpoint stays-blocked one-notice-per-input notice-points-to-new-session"),
	scenario("in-memory-session", "prompt-sent", "prompt-sent"),
	scenario("other-pi-version", "fresh-session-usable no-marker", "prompt-sent"),
	scenario("failed-compaction-notices", "rejected-and-blocked one-notice-for-failure one-notice-per-blocked-input explicit-retry-recovers"),
	scenario("work-notes", "guideline forged-notes-refused note-saved notes-commit disk-confirmed user-words note-claim-stays-data correction-in-context restart section-tamper-blocks explicit-recovery same-id-edit-blocks"),
	scenario("prepared-candidate", "no-note-guideline prepared branch-switch-drops-candidate sync-on-new-branch unknown-usage cancelled-preparation journal-survives-restart"),
	scenario("long-session-overhead", "compactions-succeed per-request-budget bounded-growth"),
];

const FULL_CASES = SCENARIOS.flatMap(({ name, variants }) => variants.map(({ variant, keys }) => ({ case: name, variant, keys })));

function record(value, label) {
	assert(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
}

function exactKeys(value, keys, label) {
	record(value, label);
	assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} fields must match the reviewed contract`);
}

function digest(value, length) {
	return typeof value === "string" && value.length === length && !/[^0-9a-f]/.test(value);
}

function assertCandidate(candidate, label) {
	exactKeys(candidate, CANDIDATE_FIELDS, label);
	assert(typeof candidate.version === "string" && candidate.version.length > 0 && candidate.version.trim() === candidate.version && !/\s/.test(candidate.version), `${label} version is missing or malformed`);
	assert(candidate.sourceCommit === null || digest(candidate.sourceCommit, 40), `${label} source commit is malformed`);
	for (const key of ["sourceHash", "manifestHash", "entryHash", "buildMetadataHash"]) {
		assert(digest(candidate[key], 64), `${label} ${key} is missing or malformed`);
	}
	assert.equal(candidate.build, `stock-preview+src.${candidate.sourceHash.slice(0, 16)}`, `${label} build must match its source hash`);
}

/** Reject an unsupported profile/version before running any scenario workers. */
export function assertProfileVersion(profile, version) {
	assert(profile === "strict" || profile === PROFILE, `Unknown scenario acceptance profile: ${String(profile)}`);
	if (profile === PROFILE) assert.equal(version, VERSION, `${PROFILE} is authorized only for ${VERSION}`);
}

function validateFullReport(report) {
	record(report, "Scenario report");
	assertCandidate(report.candidate, "Scenario candidate");
	exactKeys(report.scope, ["only", "checkpointTarget", "otherHostVersion"], "Scenario scope");
	assert.equal(report.scope.only, null, "Acceptance requires the full scenario suite");
	assert.equal(report.scope.checkpointTarget, 20, "Acceptance requires 20 checkpoints");
	assert.equal(report.scope.otherHostVersion, "1.0.4", "Acceptance requires official Pi 1.0.4 coverage");
	assert(Array.isArray(report.knownGaps), "Scenario known gaps must be an array");
	assert(report.knownGaps.length === 0 || (report.knownGaps.length === 1 && report.knownGaps[0] === BUDGET), "Only the existing per-request budget may be a known gap");
	assert(Array.isArray(report.cases), "Scenario raw cases must be an array");
	assert.equal(report.cases.length, FULL_CASES.length, "Scenario raw cases are incomplete or duplicated");
	assert(Array.isArray(report.checks), "Scenario graded checks must be an array");
	const counts = { pass: 0, gap: 0, fail: 0, nowPasses: 0, skipped: 0 };
	const identifiers = new Set();
	let index = 0;
	for (let caseIndex = 0; caseIndex < FULL_CASES.length; caseIndex++) {
		const expected = FULL_CASES[caseIndex];
		const result = report.cases[caseIndex];
		record(result, "Scenario raw case");
		assert.equal(result.case, expected.case, "Scenario raw case matrix must match the full suite");
		assert.equal(result.variant, expected.variant, "Scenario raw variant matrix must match the full suite");
		assert(!("skipped" in result), "Acceptance cannot skip a scenario");
		const pi = expected.case === "other-pi-version" ? "1.0.4" : report.candidate.version === "0.4.2" ? "1.2.0" : "1.1.0";
		assert.equal(result.pi, pi, "Scenario must use the reviewed official Pi version");
		assert(Array.isArray(result.checks), "Scenario raw checks must be an array");
		assert.deepEqual(result.checks.map((check) => check?.key), expected.keys, "Scenario raw assertions are incomplete, duplicated or unreviewed");
		for (const raw of result.checks) {
			record(raw, "Scenario raw assertion");
			assert.equal(typeof raw.passed, "boolean", "Scenario raw assertion must retain its boolean result");
			assert(typeof raw.description === "string" && raw.description.length > 0, "Scenario assertion description is missing");
			const id = `${expected.case}${expected.variant === "control" ? ":control" : ""}/${raw.key}`;
			assert(!identifiers.has(id), "Scenario graded checks cannot be duplicated");
			identifiers.add(id);
			const gap = report.knownGaps.includes(id);
			const status = raw.passed ? (gap ? "now-passes" : "pass") : gap ? "known-gap" : "fail";
			const graded = report.checks[index++];
			exactKeys(graded, ["id", "description", "status", "pi"], "Scenario graded assertion");
			assert.deepEqual(graded, { id, description: raw.description, status, pi }, "Scenario grading must preserve each raw assertion");
			if (status === "pass") counts.pass++;
			else if (status === "known-gap") counts.gap++;
			else if (status === "now-passes") counts.nowPasses++;
			else counts.fail++;
		}
	}
	assert.equal(report.checks.length, index, "Scenario graded assertions are incomplete or duplicated");
	exactKeys(report.summary, SUMMARY_FIELDS, "Scenario summary");
	assert.deepEqual(report.summary, counts, "Scenario summary must preserve the raw status counts");
	assert.equal(report.passed, counts.fail === 0 && counts.nowPasses === 0, "Scenario passed must preserve strict raw grading");
}

function frozenGrade({ profile, version, accepted, rawPassed, exceptions, reasons }) {
	return Object.freeze({ profile, version, accepted, rawPassed, exceptions: Object.freeze(exceptions.map((exception) => Object.freeze(exception))), reasons: Object.freeze(reasons) });
}

/** Grade without changing any raw assertion, summary, status or strict passed field. */
export function gradeScenarioAcceptance(report, profile = "strict") {
	const version = report?.candidate?.version ?? null;
	const rawPassed = report?.passed === true;
	const exceptions = [];
	try {
		assertProfileVersion(profile, version);
		// Partial diagnostics keep the runner's pre-existing strict exit behavior. Publication always
		// validates the complete report again in assertScenarioAcceptance below.
		if (profile === "strict") return frozenGrade({ profile, version, accepted: rawPassed, rawPassed, exceptions, reasons: [] });
		validateFullReport(report);
		for (const check of report.checks) {
			if (check.status === "pass") continue;
			if (check.id === BUDGET && check.status === "known-gap") {
				exceptions.push({ id: check.id, status: check.status, criterion: "per-request-budget", pi: check.pi });
			} else if (check.id === GROWTH && check.status === "fail") {
				exceptions.push({ id: check.id, status: check.status, criterion: "checkpoint-overhead-growth-required", pi: check.pi });
			} else {
				throw new Error(`Unapproved scenario result: ${check.id} (${check.status})`);
			}
		}
		return frozenGrade({ profile, version, accepted: true, rawPassed, exceptions, reasons: [] });
	} catch (error) {
		return frozenGrade({ profile, version, accepted: false, rawPassed, exceptions: [], reasons: [error instanceof Error ? error.message : String(error)] });
	}
}

/** Verify recorded acceptance against the full raw evidence and the exact publication candidate. */
export function assertScenarioAcceptance(report, { profile = "strict", candidate } = {}) {
	assertCandidate(candidate, "Expected publication candidate");
	assert(digest(candidate.sourceCommit, 40), "Publication requires a final source commit");
	assertProfileVersion(profile, candidate.version);
	validateFullReport(report);
	for (const key of CANDIDATE_FIELDS) assert.equal(report.candidate[key], candidate[key], `Scenario candidate ${key} does not match publication`);
	const grade = gradeScenarioAcceptance(report, profile);
	assert.deepEqual(report.acceptance, grade, "Recorded scenario acceptance does not match recomputed raw evidence");
	assert(grade.accepted, `Scenario acceptance rejected: ${grade.reasons.join("; ") || "strict scenario checks failed"}`);
	return grade;
}

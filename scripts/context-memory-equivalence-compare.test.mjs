import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
// Importing the comparator compares nothing: only its helpers are read here.
import {
	checkpointRecords,
	compareEquivalence,
	EQUIVALENCE_VERSION,
	equivalenceLine,
	errorClasses,
	readEquivalence,
	sessionLines,
} from "./context-memory-equivalence-compare.mjs";

const comparator = fileURLToPath(new URL("./context-memory-equivalence-compare.mjs", import.meta.url));
const bench = fileURLToPath(new URL("./context-memory-preview-bench.mjs", import.meta.url));

function scratch(t) {
	const directory = mkdtempSync(join(tmpdir(), "pi-equivalence-test-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
/** Text that must never reach an equivalence line. */
const SECRET = ["Invented ruling about port 7319", "Never rotate the invented key", "Only the invented staging host", "Earlier invented user words"];

/**
 * An invented session: fixed fixture IDs for the messages, `random` for what Pi would generate (a model change and
 * the checkpoint), and a checkpoint whose note and summary cite both kinds.
 */
function session(random, { summaryTail = "" } = {}) {
	const note = {
		instructions: [{ text: SECRET[0], sources: ["fx-0001"], quote: SECRET[1] }],
		failedPaths: [],
		reasons: [{ text: SECRET[2], sources: ["fx-0001", "fx-0003"] }],
		state: [{ text: "State.", sources: ["fx-0003"] }],
		nextSteps: [{ text: "Next.", sources: [random.change] }],
		files: [],
		gaps: ["An invented open question"],
	};
	const summary = `Context memory.\n## instructions\n- ${SECRET[0]} [fx-0001]\n## state\n- State. [fx-0003]\n- through ${random.change}: State.\n## Earlier user messages\n${JSON.stringify({ entryId: "fx-0001", text: SECRET[3] })}${summaryTail}`;
	return [
		{ type: "session", version: 3, id: random.session, timestamp: random.time, cwd: "/invented/cwd" },
		{ type: "message", id: "fx-0001", parentId: null, timestamp: random.time, message: { role: "user", content: SECRET[3] } },
		{ type: "model_change", id: random.change, parentId: "fx-0001", timestamp: random.time, provider: "loopback", modelId: "loopback" },
		{ type: "message", id: "fx-0003", parentId: random.change, timestamp: random.time, message: { role: "assistant", content: [{ type: "text", text: SECRET[2] }] } },
		{ type: "compaction", id: random.checkpoint, parentId: "fx-0003", timestamp: random.time, summary, details: { kind: "pi-context-memory", version: 1, note, coveredThrough: random.change, build: "invented-build" } },
		{ type: "compaction", id: "native-1", parentId: random.checkpoint, timestamp: random.time, summary: SECRET[0], details: { kind: "native" } },
	];
}
const FIRST = { session: "5e55-a", change: "a1b2c3d4", checkpoint: "e5f6a7b8", time: "2026-10-22T10:00:00.000Z" };
const SECOND = { session: "5e55-b", change: "0badf00d", checkpoint: "deadbeef", time: "2026-10-22T11:30:00.000Z" };
const STABLE = new Set(["fx-0001", "fx-0003"]);

test("a checkpoint record carries hashes, cited IDs and classes, never note text, quotes or session content", () => {
	const lines = session(FIRST);
	const [record] = checkpointRecords(lines, STABLE);
	assert.equal(checkpointRecords(lines, STABLE).length, 1, "a native checkpoint is not the preview's");
	assert.deepEqual(Object.keys(record), ["entry", "coveredThrough", "noteSha256", "summarySha256", "citations"]);
	assert.match(record.noteSha256, /^[0-9a-f]{64}$/);
	assert.match(record.summarySha256, /^[0-9a-f]{64}$/);
	// Fixture IDs stay raw; Pi's random IDs become positions among the entries.
	assert.equal(record.entry, "@3");
	assert.equal(record.coveredThrough, "@1");
	assert.deepEqual(record.citations, { instructions: [["fx-0001"]], failedPaths: [], reasons: [["fx-0001", "fx-0003"]], state: [["fx-0003"]], nextSteps: [["@1"]], files: [] });

	const notices = ["Source-linked compaction: checkpoint not saved. A quote is wrong. (CONTEXT_NOTE_QUOTE)", "HISTORY_QUERY_INVALID: kind applies to list only", "plain text", undefined];
	const classes = errorClasses(...notices, "CONTEXT_NOTE_QUOTE");
	assert.deepEqual(classes, ["CONTEXT_NOTE_QUOTE", "HISTORY_QUERY_INVALID", "CONTEXT_NOTE_QUOTE"]);
	const line = equivalenceLine({ runner: "bench", id: "bench/writer/FX/cut1/attempt1", host: "1.3.0", checkpoints: [record], classes, extra: { outcome: "committed" }, build: "invented-build" });
	assert.ok(line.endsWith("}\n") && !line.slice(0, -1).includes("\n"), "one JSON line");
	const parsed = JSON.parse(line);
	assert.deepEqual(Object.keys(parsed), ["equivalence", "runner", "case", "host", "outcome", "checkpoints", "classes", "build"]);
	assert.equal(parsed.equivalence, EQUIVALENCE_VERSION);
	for (const text of [...SECRET, "An invented open question", "State.", "Next.", "/invented/cwd", FIRST.time, FIRST.change, FIRST.checkpoint, "plain text", "kind applies"])
		assert.ok(!line.includes(text), `the line leaks ${JSON.stringify(text)}`);
});

test("records are deterministic: another run's random IDs and times give the same line, and with fixed IDs the note hash is the stored bytes'", () => {
	const first = checkpointRecords(session(FIRST), STABLE);
	const second = checkpointRecords(session(SECOND), STABLE);
	assert.deepEqual(second, first);
	const line = (checkpoints) => equivalenceLine({ runner: "scenarios", id: "scenarios/x/extension", host: "1.3.0", checkpoints, classes: [], build: "b" });
	assert.equal(line(second), line(first));

	// A note citing only fixed IDs is hashed exactly as Pi stored it.
	const lines = session(FIRST);
	lines[4].details.note.nextSteps[0].sources = ["fx-0003"];
	const stored = JSON.stringify(lines[4]);
	const noteBytes = JSON.stringify(lines[4].details.note);
	assert.ok(stored.includes(noteBytes));
	assert.equal(checkpointRecords(sessionLines(`${lines.map((entry) => JSON.stringify(entry)).join("\n")}\n`), STABLE)[0].noteSha256, sha256(noteBytes));

	// Any change of note or summary bytes changes its hash; only the hash of what changed moves.
	const edited = session(FIRST);
	edited[4].details.note.state[0].text = "State!";
	const [changed] = checkpointRecords(edited, STABLE);
	assert.notEqual(changed.noteSha256, first[0].noteSha256);
	assert.equal(changed.summarySha256, first[0].summarySha256);
	const [rendered] = checkpointRecords(session(FIRST, { summaryTail: " " }), STABLE);
	assert.notEqual(rendered.summarySha256, first[0].summarySha256);
	assert.equal(rendered.noteSha256, first[0].noteSha256);
});

test("the comparator passes equal files, ignores the build stamp and names every differing case and field", () => {
	const [record] = checkpointRecords(session(FIRST), STABLE);
	const make = (id, overrides = {}) => JSON.parse(equivalenceLine({ runner: "bench", id, host: "1.3.0", checkpoints: [record], classes: ["CONTEXT_NOTE_QUOTE"], extra: { outcome: "refused" }, build: "before-build", ...overrides }));
	const file = (...records) => records.map((item) => JSON.stringify(item)).join("\n");
	const before = readEquivalence(file(make("a"), make("b"), make("c")));

	const same = compareEquivalence(before, readEquivalence(file(make("c", { build: "after-build" }), make("a", { build: "after-build" }), make("b", { build: "after-build" }))));
	assert.deepEqual(same, { cases: 3, equal: true, differences: [] });

	const doctored = make("b");
	doctored.checkpoints[0].noteSha256 = "0".repeat(64);
	doctored.checkpoints[0].citations.reasons[0] = ["fx-0003", "fx-0001"];
	const reclassed = make("c", { classes: ["CONTEXT_NOTE_QUOTE", "CONTEXT_NOTE_SCOPE"] });
	const result = compareEquivalence(before, readEquivalence(file(make("a"), doctored, reclassed, make("d"))));
	assert.equal(result.equal, false);
	assert.deepEqual(
		result.differences.map((item) => [item.case, item.field ?? `missing:${item.missing}`]),
		[
			["b", "checkpoints[0].citations.reasons[0][0]"],
			["b", "checkpoints[0].citations.reasons[0][1]"],
			["b", "checkpoints[0].noteSha256"],
			["c", "classes.length"],
			["d", "missing:before"],
		],
	);
	const fewer = compareEquivalence(before, readEquivalence(file(make("a"))));
	assert.deepEqual(fewer.differences, [
		{ case: "b", missing: "after" },
		{ case: "c", missing: "after" },
	]);
	// A field one side lacks is a difference, not a match.
	const { outcome, ...bare } = make("a");
	assert.equal(outcome, "refused");
	assert.deepEqual(compareEquivalence(readEquivalence(file(make("a"))), readEquivalence(file(bare))).differences, [{ case: "a", field: "outcome", before: "refused", after: "(absent)" }]);

	assert.throws(() => readEquivalence(file(make("a"), make("a")), "twice.jsonl"), /twice\.jsonl:2: case a is given twice/);
	assert.throws(() => readEquivalence("{}", "bare.jsonl"), /bare\.jsonl:1: no case identifier/);
	assert.throws(() => readEquivalence("not json", "text.jsonl"), /text\.jsonl:1: not JSON/);
});

test("the comparator's command exits 0 when equal, 1 naming the case and field, and 2 on a usage or file error", (t) => {
	const directory = scratch(t);
	const [record] = checkpointRecords(session(FIRST), STABLE);
	const line = (build, noteSha256 = record.noteSha256) => equivalenceLine({ runner: "bench", id: "bench/writer/FX/cut1/attempt1", host: "1.3.0", checkpoints: [{ ...record, noteSha256 }], classes: [], build });
	const write = (name, text) => {
		writeFileSync(join(directory, name), text);
		return join(directory, name);
	};
	const before = write("before.jsonl", line("before-build"));
	const after = write("after.jsonl", line("after-build"));
	const changed = write("changed.jsonl", line("before-build", "f".repeat(64)));
	const run = (...files) => spawnSync(process.execPath, [comparator, ...files], { encoding: "utf8", env: { ...process.env, PI_OFFLINE: "1" } });

	const equal = run(before, after);
	assert.equal(equal.status, 0, equal.stderr);
	assert.match(equal.stdout, /^equal: 1 cases$/m);
	const differs = run(before, changed);
	assert.equal(differs.status, 1);
	assert.match(differs.stdout, /^DIFFERS bench\/writer\/FX\/cut1\/attempt1 checkpoints\[0\]\.noteSha256: /m);
	const missing = run(before, write("empty.jsonl", ""));
	assert.equal(missing.status, 1);
	assert.match(missing.stdout, /^MISSING bench\/writer\/FX\/cut1\/attempt1: only in before$/m);
	assert.equal(run(before).status, 2);
	assert.equal(run(before, join(directory, "absent.jsonl")).status, 2);
});

test("the bench refuses --equivalence-out for a model provider or smoke mode before any unit starts", (t) => {
	const directory = scratch(t);
	const output = join(directory, "output");
	const out = join(directory, "equivalence.jsonl");
	for (const [extra, message] of [
		[["--mode", "writer", "--provider", "deepseek"], /--equivalence-out needs --provider loopback or deepseek-local/],
		[["--mode", "smoke"], /--equivalence-out records compactions; --mode smoke runs none/],
	]) {
		const result = spawnSync(process.execPath, [bench, "--package-dir", join(directory, "no-package"), "--stock-root", join(directory, "no-pi"), "--output-dir", output, ...extra, "--equivalence-out", out], {
			encoding: "utf8",
			env: { ...process.env, PI_OFFLINE: "1" },
		});
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, message);
		assert.doesNotMatch(result.stderr, /preview-build\.json|ENOENT/);
	}
	assert.equal(existsSync(output), false);
	assert.equal(existsSync(out), false);
});

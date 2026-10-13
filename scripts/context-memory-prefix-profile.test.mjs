import assert from "node:assert/strict";
import { test } from "node:test";
import { hashEntries } from "../packages/coding-agent/src/extensions/context-memory/identity.ts";
import { parseProfileOptions, runPrefixProfile, singlePassPrefixHashes } from "./context-memory-prefix-profile.mjs";

test("single-pass digests match the resident byte rule at every prefix", () => {
	const entries = [
		{ type: "message", id: "a", parentId: null, message: { role: "user", content: "中文\nline\r\n🙂" } },
		{ type: "message", id: "b", parentId: "a", message: { role: "assistant", content: [{ type: "text", text: "\"quote\"" }] } },
		{ type: "compaction", id: "c", parentId: "b", summary: "synthetic", details: { nested: [null, true, 42] } },
		{ type: "compaction", id: "d", parentId: "c", summary: "later", firstKeptEntryId: "a" },
		{ type: "custom", id: "e", parentId: "d", data: { omitted: undefined, order: { z: 1, a: 2 } } },
	];
	const boundaries = Array.from({ length: entries.length + 1 }, (_, index) => index);
	const result = singlePassPrefixHashes(entries, boundaries);
	for (const boundary of boundaries) assert.equal(result.get(boundary), hashEntries(entries.slice(0, boundary)));
});

test("empty, partial, duplicate and unordered boundaries remain exact", () => {
	assert.equal(singlePassPrefixHashes([], [0]).get(0), hashEntries([]));
	assert.equal(singlePassPrefixHashes([1, 2, 3], []).size, 0);
	const result = singlePassPrefixHashes([1, 2, 3], [2, 0, 2, 1]);
	assert.deepEqual([...result.keys()], [0, 1, 2]);
	assert.equal(result.get(2), hashEntries([1, 2]));
});

test("source tampering changes every affected prefix without changing the leaf", () => {
	const entries = [{ id: "a", text: "approved 4317" }, { id: "b", parentId: "a" }];
	const original = singlePassPrefixHashes(entries, [0, 1, 2]);
	entries[0].text = "approved 4318";
	const changed = singlePassPrefixHashes(entries, [0, 1, 2]);
	assert.equal(changed.get(0), original.get(0));
	assert.notEqual(changed.get(1), original.get(1));
	assert.notEqual(changed.get(2), original.get(2));
});

test("invalid prefix positions are refused", () => {
	for (const boundary of [-1, 1.5, 3, Number.NaN]) {
		assert.throws(() => singlePassPrefixHashes([1, 2], [boundary]), /Invalid prefix boundary/);
	}
});

test("profile settings have explicit resource caps", () => {
	assert.deepEqual(parseProfileOptions(["--checkpoints", "20,10,20"]).checkpoints, [10, 20]);
	for (const args of [["--repeats"], ["--repeats", "0"], ["--unknown", "1"], ["--checkpoints", "100", "--entries-per-checkpoint", "1000"]]) {
		assert.throws(() => parseProfileOptions(args));
	}
});

test("profile reports individual kernel timings without a request-latency claim", () => {
	const report = runPrefixProfile(parseProfileOptions(["--checkpoints", "2,3", "--entries-per-checkpoint", "2", "--text-bytes", "8", "--repeats", "2"]));
	assert.equal(report.evidence, "synthetic-hash-kernel-only");
	assert.equal(report.rows.length, 2);
	for (const row of report.rows) {
		assert.equal(row.hashesEqual, true);
		assert.equal(row.repeatedPrefixMs.length, 2);
		assert.equal(row.singlePassMs.length, 2);
		assert.ok(row.repeatedPrefixMs.every((time) => time >= 0));
		assert.ok(row.singlePassMs.every((time) => time >= 0));
	}
	assert.ok(report.limitations.some((limit) => limit.includes("disk readback")));
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { pressureProfile } from "./context-memory-pressure-profile.mjs";

test("host fragments preserve the target for declared limits, including a smaller input ceiling", () => {
	for (const contextWindow of [128_000, 200_000, 1_000_000]) {
		for (const inputLimit of [contextWindow, Math.floor(contextWindow * 0.6)]) {
			const output = 32_000;
			const profile = pressureProfile({ contextWindow, maxOutputTokens: output, inputLimit });
			const target = profile.plan.triggerTokens;
			assert.equal(contextWindow - profile.pi.settings.compaction.reserveTokens, target);
			assert.equal(inputLimit - profile.opencode.config.compaction.reserved, target);
			const dsh = profile.dsh.config;
			assert.equal(Math.floor(Math.min(contextWindow * dsh.thresholdRatio, contextWindow - output - dsh.headroomTokens)), target);
			assert.equal(profile.pi.slice.compactAt, target);
			assert.equal(profile.pi.slice.keepRecentTokens, dsh.retainTokens);
			assert.equal(profile.opencode.config.compaction.prune, false);
			assert.equal(dsh.maxTokens, 8192);
			assert.equal(Object.hasOwn(dsh, "retainRatio"), false);
			assert.equal(Object.hasOwn(profile.pi.slice, "previewPreparation"), false);
		}
	}
});

test("OpenCode without limit.input reports its actual 168k line, not the requested 150k", () => {
	const profile = pressureProfile({ contextWindow: 200_000, maxOutputTokens: 32_000 });
	assert.equal(profile.plan.triggerTokens, 150_000);
	assert.equal(profile.opencode.nativeTriggerTokens, 168_000);
	assert.equal(profile.opencode.status, "needs-input-limit");
	assert.equal(Object.hasOwn(profile.opencode.config.compaction, "reserved"), false);
	assert.match(profile.opencode.warning, /does not implement the target trigger/);
});

test("CLI requires capacity evidence, prints usable JSON and rejects unknown options", () => {
	const script = fileURLToPath(new URL("./context-memory-pressure-profile.mjs", import.meta.url));
	for (const args of [[], ["--context", "200000"], ["--context", "200000", "--output", "NaN"], ["--write"]]) {
		const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
		assert.equal(result.status, 2);
		assert.equal(result.stdout, "");
	}
	const result = spawnSync(process.execPath, [script, "--context", "200000", "--output", "32000", "--input", "200000"], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(JSON.parse(result.stdout).opencode.config.compaction.reserved, 50_000);
});

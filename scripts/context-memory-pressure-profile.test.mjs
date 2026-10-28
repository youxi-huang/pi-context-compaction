import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { pressureProfile } from "./context-memory-pressure-profile.mjs";

test("a 200k/32k route compacts at 150k on every host, keeping 15k of recent text", () => {
	const profile = pressureProfile({ contextWindow: 200_000, maxOutputTokens: 32_000, inputLimit: 200_000 });
	assert.deepEqual(profile.pi, { settings: { compaction: { reserveTokens: 50_000, keepRecentTokens: 15_000 } }, slice: { keepRecentTokens: 15_000 } });
	assert.deepEqual(profile.opencode.config.compaction, { auto: true, prune: false, preserve_recent_tokens: 15_000, reserved: 50_000 });
	assert.deepEqual(profile.dsh.config, { thresholdRatio: 0.75, headroomTokens: 18_000, retainTokens: 15_000, maxTokens: 8192 });
	assert.deepEqual(pressureProfile({ contextWindow: 200_000, maxOutputTokens: 32_000, model: "deepseek/v4" }).pi.settings, { compaction: { modelOverrides: { "deepseek/v4": { reserveTokens: 50_000, keepRecentTokens: 15_000 } } } });
});

test("each native fragment lands on the target, below output and input limits, from 128k to 1M", () => {
	for (const contextWindow of [128_000, 200_000, 262_144, 1_000_000]) {
		for (const output of [4096, 32_000, 64_000]) {
			for (const inputLimit of [contextWindow, Math.floor(contextWindow * 0.6)]) {
				const { targetTokens: target, keepRecentTokens, pi, opencode, dsh } = pressureProfile({ contextWindow, maxOutputTokens: output, inputLimit });
				assert(target + output + 8192 <= contextWindow && target + 8192 <= inputLimit);
				assert.equal(contextWindow - pi.settings.compaction.reserveTokens, target);
				assert.equal(inputLimit - opencode.config.compaction.reserved, target);
				assert.equal(Math.floor(Math.min(contextWindow * dsh.config.thresholdRatio, contextWindow - output - dsh.config.headroomTokens)), target);
				assert(keepRecentTokens > 0 && keepRecentTokens < target / 2);
			}
		}
	}
});

test("OpenCode without limit.input reports its actual 168k line and omits an ineffective reserved", () => {
	const { targetTokens, opencode } = pressureProfile({ contextWindow: 200_000, maxOutputTokens: 32_000 });
	assert.equal(targetTokens, 150_000);
	assert.equal(opencode.status, "needs-input-limit");
	assert.equal(opencode.nativeTriggerTokens, 168_000);
	assert.equal(Object.hasOwn(opencode.config.compaction, "reserved"), false);
});

test("invalid or contradictory limits are refused instead of assuming a window", () => {
	const valid = { contextWindow: 200_000, maxOutputTokens: 32_000 };
	for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
		for (const key of ["contextWindow", "maxOutputTokens", "inputLimit"]) assert.throws(() => pressureProfile({ ...valid, [key]: value }), /CONTEXT_CAPACITY/);
	}
	for (const limits of [{ contextWindow: 200_000, maxOutputTokens: 200_000 }, { contextWindow: 128_000, maxOutputTokens: 8192, inputLimit: 200_000 }, { contextWindow: 16_384, maxOutputTokens: 8192 }]) {
		assert.throws(() => pressureProfile(limits), /CONTEXT_CAPACITY/);
	}
});

test("the CLI prints JSON only for complete arguments and never accepts a write option", () => {
	const script = fileURLToPath(new URL("./context-memory-pressure-profile.mjs", import.meta.url));
	const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
	for (const args of [[], ["--context", "200000"], ["--context", "200000", "--output", "NaN"], ["--context", "200000", "--output", "32000", "--model", "no-provider"], ["--write"]]) {
		const result = run(...args);
		assert.equal(result.status, 2);
		assert.equal(result.stdout, "");
	}
	const declared = run("--context", "200000", "--output", "32000", "--input", "200000");
	assert.equal(declared.status, 0, declared.stderr);
	assert.equal(JSON.parse(declared.stdout).opencode.config.compaction.reserved, 50_000);
	assert.equal(declared.stderr, "");
	const missing = run("--context", "200000", "--output", "32000");
	assert.equal(missing.status, 0);
	assert.match(missing.stderr, /stays at 168000/);
});

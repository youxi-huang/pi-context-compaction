import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { hashEntries } from "../packages/coding-agent/src/extensions/context-memory/identity.ts";

/** Review prototype only. The resident and preview request validators do not import it. */
export function singlePassPrefixHashes(entries, boundaries) {
	const positions = [...new Set(boundaries)].sort((left, right) => left - right);
	if (positions.some((position) => !Number.isSafeInteger(position) || position < 0 || position > entries.length)) {
		throw new Error("Invalid prefix boundary");
	}
	const result = new Map();
	if (!positions.length) return result;
	const hash = createHash("sha256");
	let next = 0;
	if (positions[next] === 0) {
		result.set(0, hash.copy().digest("hex"));
		next++;
	}
	for (let index = 0; next < positions.length && index < entries.length; index++) {
		hash.update(JSON.stringify(entries[index])).update("\n");
		if (positions[next] === index + 1) {
			result.set(index + 1, hash.copy().digest("hex"));
			next++;
		}
	}
	return result;
}

export function repeatedPrefixHashes(entries, boundaries) {
	return new Map(boundaries.map((position) => [position, hashEntries(entries.slice(0, position))]));
}

function positiveInteger(value, label, maximum) {
	const number = Number(value);
	if (!Number.isSafeInteger(number) || number < 1 || number > maximum) throw new Error(`Invalid ${label}`);
	return number;
}

export function parseProfileOptions(args) {
	const options = { checkpoints: [10, 20, 60], entriesPerCheckpoint: 100, textBytes: 512, repeats: 3 };
	for (let index = 0; index < args.length; index += 2) {
		const flag = args[index];
		const value = args[index + 1];
		if (value === undefined) throw new Error(`Missing value for ${flag}`);
		switch (flag) {
			case "--checkpoints":
				options.checkpoints = [...new Set(value.split(",").map((item) => positiveInteger(item, "checkpoints", 100)))].sort(
					(left, right) => left - right,
				);
				break;
			case "--entries-per-checkpoint":
				options.entriesPerCheckpoint = positiveInteger(value, "entries per checkpoint", 1000);
				break;
			case "--text-bytes":
				options.textBytes = positiveInteger(value, "text bytes", 8192);
				break;
			case "--repeats":
				options.repeats = positiveInteger(value, "repeats", 10);
				break;
			default:
				throw new Error(`Unknown flag: ${flag}`);
		}
	}
	const count = Math.max(...options.checkpoints) * options.entriesPerCheckpoint;
	if (count > 20_000 || count * (options.textBytes + 256) > 64 * 1024 * 1024) {
		throw new Error("Synthetic profile exceeds its record or byte budget");
	}
	return options;
}

function syntheticEntries(count, textBytes) {
	return Array.from({ length: count }, (_, index) => ({
		type: "message",
		id: `synthetic-${index}`,
		parentId: index ? `synthetic-${index - 1}` : null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role: index % 2 ? "assistant" : "user", content: "x".repeat(textBytes), timestamp: index },
	}));
}

function timed(action) {
	const start = performance.now();
	action();
	return Number((performance.now() - start).toFixed(3));
}

function equivalent(left, right) {
	return left.size === right.size && [...left].every(([position, digest]) => digest === right.get(position));
}

export function runPrefixProfile(options) {
	const rows = options.checkpoints.map((checkpoints) => {
		const entries = syntheticEntries(checkpoints * options.entriesPerCheckpoint, options.textBytes);
		const boundaries = [0, ...Array.from({ length: checkpoints }, (_, index) => (index + 1) * options.entriesPerCheckpoint)];
		const oldHashes = repeatedPrefixHashes(entries, boundaries);
		const newHashes = singlePassPrefixHashes(entries, boundaries);
		if (!equivalent(oldHashes, newHashes)) throw new Error("PREFIX_HASH_MISMATCH");
		const oldMs = [];
		const newMs = [];
		for (let repeat = 0; repeat < options.repeats; repeat++) {
			const oldRun = () => oldMs.push(timed(() => repeatedPrefixHashes(entries, boundaries)));
			const newRun = () => newMs.push(timed(() => singlePassPrefixHashes(entries, boundaries)));
			if (repeat % 2) {
				newRun();
				oldRun();
			} else {
				oldRun();
				newRun();
			}
		}
		return {
			checkpoints,
			entries: entries.length,
			serializedBytes: entries.reduce((sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry)) + 1, 0),
			boundariesCompared: boundaries.length,
			hashesEqual: true,
			fullSourceHash: newHashes.get(entries.length),
			repeatedPrefixMs: oldMs,
			singlePassMs: newMs,
		};
	});
	return {
		kind: "context-memory-prefix-profile",
		version: 1,
		evidence: "synthetic-hash-kernel-only",
		node: process.version,
		prototypeSha256: createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex"),
		referenceSha256: createHash("sha256")
			.update(readFileSync(fileURLToPath(new URL("../packages/coding-agent/src/extensions/context-memory/identity.ts", import.meta.url))))
			.digest("hex"),
		options,
		limitations: [
			"This prototype does not change runtime validation or build identity.",
			"Timings exclude disk readback, note/schema/quotation checks and request hooks.",
			"No provider calls, cache measurements or recovery-quality results are included.",
		],
		rows,
	};
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	try {
		console.log(JSON.stringify(runPrefixProfile(parseProfileOptions(process.argv.slice(2))), null, 2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : "Prefix profile failed");
		process.exitCode = 1;
	}
}

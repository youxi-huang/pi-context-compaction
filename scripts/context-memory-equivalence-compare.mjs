import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The v0.7.0 equivalence run: content-free records of what one preview build did with scripted inputs, and their
// comparison across two builds.
//
// With --equivalence-out <file>, context-memory-preview-scenarios.mjs appends one line per case and variant, and
// context-memory-preview-bench.mjs one line per measured unit or cut. A line carries, for each committed checkpoint
// in the case's session files, the SHA-256 of its stored note's JSON bytes and of its summary, and the record IDs
// each fact cites; and the error classes the case raised, in the order observed. Never note text, quotes or session
// content: hashes, IDs, classes and counts only. Entry IDs the inputs fix (the bench's invented fixture IDs) stay
// raw; IDs Pi generates at random are replaced by their position in the session file, `@<index>`, before anything is
// hashed, so two runs of one build give identical files. With only fixed IDs the note hash is that of the stored
// bytes themselves.
//
//   node scripts/context-memory-equivalence-compare.mjs <before.jsonl> <after.jsonl>
//
// pairs lines by `case`, exits 0 when every pair matches and 1 naming each differing case and field, and each case
// present on one side only. The top-level `build` field identifies the build under test and is not compared;
// everything else is compared exactly.

export const EQUIVALENCE_VERSION = "0.7-equivalence.1";
/** Top-level fields that identify the build under test. They are recorded for the reader and never compared. */
export const BUILD_SPECIFIC = Object.freeze(["build"]);
/** The note sections whose facts cite records; `gaps` holds plain strings and is covered by the note hash only. */
const CITING_SECTIONS = ["instructions", "failedPaths", "reasons", "state", "nextSteps", "files"];
const CLASS = /\b(?:CONTEXT|HISTORY)_[A-Z_]{1,40}\b/g;
const CHECKPOINT_KIND = "pi-context-memory";
const usage = "Usage: node scripts/context-memory-equivalence-compare.mjs <before.jsonl> <after.jsonl>";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** The CONTEXT_* and HISTORY_* codes in each text, in order; absent texts are skipped. Nothing else is kept. */
export function errorClasses(...texts) {
	return texts.flatMap((text) => (typeof text === "string" ? (text.match(CLASS) ?? []) : []));
}

/**
 * Aliases for entry IDs the inputs do not fix: each becomes `@<index>`, its position among the file's entries. A
 * Pi-generated ID is random, its position is not.
 */
function idAliases(entries, stableIds) {
	const aliases = new Map();
	entries.forEach((entry, index) => {
		if (typeof entry?.id === "string" && entry.id && !stableIds.has(entry.id)) aliases.set(entry.id, `@${index}`);
	});
	return aliases;
}

/** `value` with every string that is exactly an aliased ID replaced; key order and everything else kept. */
function aliasValue(value, aliases) {
	if (typeof value === "string") return aliases.get(value) ?? value;
	if (Array.isArray(value)) return value.map((item) => aliasValue(item, aliases));
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, aliasValue(item, aliases)]));
	return value;
}

/** `text` with every occurrence of an aliased ID replaced, longest IDs first. */
function aliasText(text, aliases) {
	if (!aliases.size) return text;
	const pattern = new RegExp([...aliases.keys()].sort((a, b) => b.length - a.length || (a < b ? -1 : 1)).map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
	return text.replace(pattern, (id) => aliases.get(id));
}

/**
 * One record per committed preview checkpoint in a parsed session file (`lines[0]` is the header), in file order:
 * the entry and its coverage end as IDs, the note and summary hashes, and the ordered sources of each fact by
 * section. `stableIds` are the IDs the inputs fix and are kept raw.
 */
export function checkpointRecords(lines, stableIds = new Set()) {
	const entries = lines.slice(1);
	const aliases = idAliases(entries, stableIds);
	return entries
		.filter((entry) => entry?.type === "compaction" && entry.details?.kind === CHECKPOINT_KIND)
		.map((entry) => {
			const note = aliasValue(entry.details.note ?? null, aliases);
			return {
				entry: aliases.get(entry.id) ?? entry.id,
				coveredThrough: aliasValue(entry.details.coveredThrough ?? null, aliases),
				noteSha256: sha256(JSON.stringify(note)),
				summarySha256: sha256(aliasText(typeof entry.summary === "string" ? entry.summary : "", aliases)),
				citations: Object.fromEntries(
					CITING_SECTIONS.map((section) => [section, Array.isArray(note?.[section]) ? note[section].map((fact) => (Array.isArray(fact?.sources) ? fact.sources.map(String) : [])) : []]),
				),
			};
		});
}

/** Parses a session file's JSONL text into its lines, header first. */
export function sessionLines(text) {
	return text
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line));
}

/**
 * One equivalence line. `id` is the stable case identifier, `host` the Pi version, `checkpoints` from
 * `checkpointRecords`, `classes` from `errorClasses`; `extra` holds further content-free fields such as an
 * outcome label. `build` is the package's build stamp and the only field the comparison skips.
 */
export function equivalenceLine({ runner, id, host, checkpoints = [], classes = [], extra = {}, build }) {
	return `${JSON.stringify({ equivalence: EQUIVALENCE_VERSION, runner, case: id, host, ...extra, checkpoints, classes, build: build ?? null })}\n`;
}

/** The records of one equivalence file by case. A malformed line or a case given twice is an error. */
export function readEquivalence(text, label = "file") {
	const records = new Map();
	text.split("\n").forEach((line, index) => {
		if (!line.trim()) return;
		let record;
		try {
			record = JSON.parse(line);
		} catch {
			throw new Error(`${label}:${index + 1}: not JSON`);
		}
		if (!record || typeof record !== "object" || typeof record.case !== "string" || !record.case) throw new Error(`${label}:${index + 1}: no case identifier`);
		if (records.has(record.case)) throw new Error(`${label}:${index + 1}: case ${record.case} is given twice`);
		records.set(record.case, record);
	});
	return records;
}

/** Paths below `path` at which `left` and `right` differ, each with both values, or with lengths for arrays. */
function differences(left, right, path) {
	if (Array.isArray(left) && Array.isArray(right)) {
		if (left.length !== right.length) return [{ field: `${path}.length`, before: left.length, after: right.length }];
		return left.flatMap((item, index) => differences(item, right[index], `${path}[${index}]`));
	}
	const objects = [left, right].every((value) => value && typeof value === "object" && !Array.isArray(value));
	if (objects) {
		const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
		return keys.flatMap((key) =>
			!Object.hasOwn(left, key) || !Object.hasOwn(right, key)
				? [{ field: `${path}.${key}`, before: Object.hasOwn(left, key) ? left[key] : "(absent)", after: Object.hasOwn(right, key) ? right[key] : "(absent)" }]
				: differences(left[key], right[key], `${path}.${key}`),
		);
	}
	return JSON.stringify(left) === JSON.stringify(right) ? [] : [{ field: path, before: left, after: right }];
}

/**
 * Pairs two files' records by case. Returns every case present on one side only and, for each pair, every field
 * that differs outside BUILD_SPECIFIC, in case order.
 */
export function compareEquivalence(before, after) {
	const cases = [...new Set([...before.keys(), ...after.keys()])].sort();
	const found = [];
	for (const id of cases) {
		if (!before.has(id) || !after.has(id)) {
			found.push({ case: id, missing: before.has(id) ? "after" : "before" });
			continue;
		}
		const strip = (record) => Object.fromEntries(Object.entries(record).filter(([key]) => !BUILD_SPECIFIC.includes(key)));
		for (const item of differences(strip(before.get(id)), strip(after.get(id)), "")) found.push({ case: id, field: item.field.replace(/^\./, ""), before: item.before, after: item.after });
	}
	return { cases: cases.length, equal: found.length === 0, differences: found };
}

function main(argv) {
	if (argv.length !== 2) {
		console.error(usage);
		return 2;
	}
	let before;
	let after;
	try {
		before = readEquivalence(readFileSync(argv[0], "utf8"), argv[0]);
		after = readEquivalence(readFileSync(argv[1], "utf8"), argv[1]);
	} catch (error) {
		console.error(error.message);
		return 2;
	}
	const result = compareEquivalence(before, after);
	for (const item of result.differences) {
		if (item.missing) console.log(`MISSING ${item.case}: only in ${item.missing === "after" ? "before" : "after"}`);
		else console.log(`DIFFERS ${item.case} ${item.field}: ${JSON.stringify(item.before)} -> ${JSON.stringify(item.after)}`);
	}
	console.log(result.equal ? `equal: ${result.cases} cases` : `not equal: ${new Set(result.differences.map((item) => item.case)).size} of ${result.cases} cases differ`);
	return result.equal ? 0 : 1;
}

/** Comparison runs only when this file is the script node was given; the runners and tests import its helpers. */
function invoked() {
	try {
		return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return false;
	}
}

if (invoked()) process.exitCode = main(process.argv.slice(2));

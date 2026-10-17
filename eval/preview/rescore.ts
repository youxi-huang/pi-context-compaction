import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertPreviewFixture, type PreviewFixture } from "./schema.ts";
import { type ProbeScore, scoreProbe, summarizePreview } from "./scorer.ts";

/**
 * Scores the replies a bench run saved with the current scorer, so runs made under an earlier scorer version can be
 * compared on equal terms. Usage: node --experimental-strip-types eval/preview/rescore.ts <run directory>...
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

interface Loaded {
	fixture: PreviewFixture;
	ids: ReadonlySet<string>;
}

const cache = new Map<string, Loaded>();
function load(id: string): Loaded {
	const known = cache.get(id);
	if (known) return known;
	const fixture: unknown = JSON.parse(readFileSync(join(root, id, "gold.json"), "utf8"));
	assertPreviewFixture(fixture);
	const ids = new Set(
		readFileSync(join(root, id, "session.jsonl"), "utf8")
			.trimEnd()
			.split("\n")
			.slice(1)
			.map((line) => (JSON.parse(line) as { id: string }).id),
	);
	const loaded = { fixture, ids };
	cache.set(id, loaded);
	return loaded;
}

const rows = (file: string) =>
	readFileSync(file, "utf8")
		.trimEnd()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);

/** Per condition, the summary of every probe row in `runDir`; a row the bench scored as blocked stays blocked. */
export function rescoreRun(runDir: string) {
	const replies = new Map(
		rows(join(runDir, "answers.jsonl")).map((row) => [`${row.probe}|${row.condition}`, row.reply as string | null]),
	);
	const scores = new Map<string, ProbeScore[]>();
	for (const row of rows(join(runDir, "probes.jsonl"))) {
		const probeId = String(row.probe);
		const { fixture, ids } = load(probeId.split("-")[0]);
		const probe = fixture.probes.find((item) => item.id === probeId);
		if (!probe) throw new Error(`EVAL_PREVIEW_RESCORE_PROBE:${probeId}`);
		const reply = row.outcome === "blocked" ? undefined : (replies.get(`${probeId}|${row.condition}`) ?? "");
		const condition = String(row.condition);
		scores.set(condition, [...(scores.get(condition) ?? []), scoreProbe(fixture, probe, reply, ids)]);
	}
	return Object.fromEntries([...scores].map(([condition, list]) => [condition, summarizePreview(list)]));
}

if (process.argv[1] === fileURLToPath(import.meta.url))
	for (const runDir of process.argv.slice(2))
		process.stdout.write(`${JSON.stringify({ run: runDir, ...rescoreRun(runDir) })}\n`);

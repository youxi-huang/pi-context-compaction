#!/usr/bin/env node
// Summarize the local compaction event log. Read-only; no model calls; no session content is read.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const DEFAULT_FILE = join(AGENT_DIR, "context-memory-events.jsonl");

function parseArgs(argv) {
	const options = { file: DEFAULT_FILE, since: undefined, json: false, help: false };
	const value = (i, flag) => {
		if (argv[i] === undefined || argv[i].startsWith("--")) throw new Error(`${flag} expects a value`);
		return argv[i];
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") options.help = true;
		else if (arg === "--json") options.json = true;
		else if (arg === "--file") options.file = value(++i, arg);
		else if (arg === "--since") options.since = Date.parse(value(++i, arg));
		else throw new Error(`Unknown argument: ${arg}`);
	}
	if (options.since !== undefined && !Number.isFinite(options.since)) throw new Error("--since expects an ISO date");
	return options;
}

function printHelp() {
	console.log(`Usage: node scripts/context-memory-report.mjs [options]

Reads context-memory-events.jsonl (and its .1 rotation) and prints compaction counts,
error classes, durations, token overhead, guard trips and history retrieval per session.

Options:
  --file <path>   Event log (default: context-memory-events.jsonl in the agent directory,
                  honoring PI_CODING_AGENT_DIR)
  --since <iso>   Only events at or after this time
  --json          Print the summary as JSON
  -h, --help      Show this help
`);
}

function readEvents(file, since) {
	const events = [];
	for (const candidate of [`${file}.1`, file]) {
		if (!existsSync(candidate)) continue;
		for (const line of readFileSync(candidate, "utf8").split("\n")) {
			if (!line) continue;
			try {
				const event = JSON.parse(line);
				if (!event || typeof event !== "object" || typeof event.at !== "string" || typeof event.event !== "string")
					continue;
				if (since === undefined || Date.parse(event.at) >= since) events.push(event);
			} catch {
				/* A torn line from an interrupted write is skipped. */
			}
		}
	}
	return events;
}

/** Nearest-rank percentile: p90 of two values is the larger one, never the minimum. */
function percentile(values, share) {
	if (!values.length) return undefined;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(share * sorted.length) - 1))];
}

function distribution(values) {
	return values.length
		? { count: values.length, p50: percentile(values, 0.5), p90: percentile(values, 0.9), max: Math.max(...values) }
		: { count: 0 };
}

function tally(items, key) {
	const result = {};
	for (const item of items) result[key(item)] = (result[key(item)] ?? 0) + 1;
	return result;
}

function summarize(events) {
	const compactions = events.filter((event) => event.event === "compaction");
	const committed = compactions.filter((event) => event.outcome === "committed");
	const failed = compactions.filter((event) => event.outcome !== "committed");
	const sessions = new Set(events.map((event) => event.session));
	const tokensBefore = committed.reduce((total, event) => total + (event.tokensBefore ?? 0), 0);
	const writerTokens = committed.reduce((total, event) => total + (event.usage?.totalTokens ?? 0), 0);
	const tokensAfter = committed.reduce((total, event) => total + (event.tokensAfter ?? 0), 0);
	const noteTokens = committed.map((event) => event.noteTokens).filter(Number.isFinite);
	const noteBudgetShare = committed
		.filter((event) => event.noteTokens && event.noteBudget)
		.map((event) => event.noteTokens / event.noteBudget);
	const history = events.filter((event) => event.event === "history");
	const sessionsWithCheckpoint = new Set(committed.map((event) => event.session));
	const retrievalsAfterCheckpoint = history.filter((event) => {
		const first = committed.find((item) => item.session === event.session);
		return first && event.at >= first.at;
	});
	return {
		range: events.length ? { from: events[0].at, to: events[events.length - 1].at } : undefined,
		sessions: sessions.size,
		builds: [...new Set(events.map((event) => event.build))],
		compactions: {
			total: compactions.length,
			byOutcome: tally(compactions, (event) => event.outcome),
			byReason: tally(compactions, (event) => event.reason),
			writerEffort: tally(
				compactions.filter((event) => event.writerEffort !== undefined),
				(event) => event.writerEffort,
			),
			errorCodes: tally(failed, (event) => event.errorCode ?? "UNKNOWN"),
			compactMs: distribution(committed.map((event) => event.compactMs).filter(Number.isFinite)),
			writerMs: distribution(committed.map((event) => event.writerMs).filter(Number.isFinite)),
			failedCompactMs: distribution(failed.map((event) => event.compactMs).filter(Number.isFinite)),
			chunkCount: distribution(committed.map((event) => event.chunkCount).filter(Number.isFinite)),
		},
		tokens: {
			before: tokensBefore,
			writer: writerTokens,
			writerOverheadRatio: tokensBefore ? Number((writerTokens / tokensBefore).toFixed(3)) : undefined,
			afterToBeforeRatio: tokensBefore ? Number((tokensAfter / tokensBefore).toFixed(3)) : undefined,
			writerCost: Number(committed.reduce((total, event) => total + (event.usage?.cost ?? 0), 0).toFixed(4)),
			noteTokens: distribution(noteTokens),
			noteBudgetShare: noteBudgetShare.length
				? Number((noteBudgetShare.reduce((a, b) => a + b, 0) / noteBudgetShare.length).toFixed(2))
				: undefined,
		},
		guards: tally(
			events.filter((event) => event.event === "guard"),
			(event) => event.code,
		),
		history: {
			calls: history.length,
			byOperation: tally(history, (event) => event.operation),
			errors: tally(
				history.filter((event) => event.errorCode),
				(event) => event.errorCode,
			),
			emptyResults: history.filter((event) => event.entries === 0).length,
			afterCheckpoint: retrievalsAfterCheckpoint.length,
			perSessionWithCheckpoint: sessionsWithCheckpoint.size
				? Number((retrievalsAfterCheckpoint.length / sessionsWithCheckpoint.size).toFixed(2))
				: undefined,
			sessionsWithCheckpoint: sessionsWithCheckpoint.size,
		},
		notes: tally(
			events.filter((event) => event.event === "note"),
			(event) => (event.accepted ? "accepted" : (event.errorCode ?? "rejected")),
		),
		capped: tally(
			events.filter((event) => event.event === "capped"),
			(event) => event.kind,
		),
	};
}

function formatCounts(record) {
	const entries = Object.entries(record);
	return entries.length ? entries.map(([key, value]) => `${key} ${value}`).join(", ") : "none";
}

function formatDistribution(label, value, unit = "") {
	if (!value.count) return `${label}: no data`;
	return `${label}: n=${value.count}, p50 ${value.p50}${unit}, p90 ${value.p90}${unit}, max ${value.max}${unit}`;
}

function printText(summary, options) {
	if (!summary.range) {
		console.log(`No events recorded in ${options.file} (use --file to point at another agent directory).`);
		return;
	}
	const { compactions, tokens, history } = summary;
	console.log(`Events from ${summary.range.from} to ${summary.range.to}`);
	console.log(`Sessions: ${summary.sessions}; builds: ${summary.builds.join(", ")}`);
	console.log("");
	console.log(`Compactions: ${compactions.total} (${formatCounts(compactions.byOutcome)}); reasons: ${formatCounts(compactions.byReason)}`);
	console.log(`Failure classes: ${formatCounts(compactions.errorCodes)}`);
	console.log(`Writer effort (attempts that reached the writer): ${formatCounts(compactions.writerEffort)}`);
	console.log(formatDistribution("Compaction pause (committed)", compactions.compactMs, " ms"));
	console.log(formatDistribution("Writer time (committed)", compactions.writerMs, " ms"));
	console.log(formatDistribution("Time to failure", compactions.failedCompactMs, " ms"));
	console.log(formatDistribution("Writer chunks", compactions.chunkCount));
	console.log("");
	console.log(`Tokens before compaction: ${tokens.before}; writer tokens: ${tokens.writer}; writer cost: ${tokens.writerCost}`);
	console.log(`Writer overhead ratio: ${tokens.writerOverheadRatio ?? "n/a"}; after/before ratio: ${tokens.afterToBeforeRatio ?? "n/a"}`);
	console.log(`${formatDistribution("Note tokens", tokens.noteTokens)}; mean share of note budget: ${tokens.noteBudgetShare ?? "n/a"}`);
	console.log("");
	console.log(`Guard trips: ${formatCounts(summary.guards)}`);
	console.log(`History calls: ${history.calls} (${formatCounts(history.byOperation)}); errors: ${formatCounts(history.errors)}; empty results: ${history.emptyResults}`);
	console.log(`History calls after a checkpoint: ${history.afterCheckpoint} across ${history.sessionsWithCheckpoint} sessions; per such session: ${history.perSessionWithCheckpoint ?? "n/a"}`);
	console.log(`Note candidates: ${formatCounts(summary.notes)}`);
	console.log(`Sessions that hit an event quota: ${formatCounts(summary.capped)}`);
}

try {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		printHelp();
	} else {
		const summary = summarize(readEvents(options.file, options.since));
		if (options.json) console.log(JSON.stringify(summary, null, 2));
		else printText(summary, options);
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}

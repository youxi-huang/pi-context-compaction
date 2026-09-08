#!/usr/bin/env node
/** Explicit, single-branch migration. Originals are never edited; model output is reviewed before commit. */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { estimateTokens, findCutPoint, getAgentDir, ModelRuntime, SessionManager, sessionEntryToContextMessages } from "../packages/coding-agent/dist/index.js";
import { CONTEXT_MEMORY_BUILD } from "../packages/coding-agent/dist/extensions/context-memory/build.js";
import { readMemoryConfig } from "../packages/coding-agent/dist/extensions/context-memory/config.js";
import { CONTEXT_MEMORY_KIND, hashEntries } from "../packages/coding-agent/dist/extensions/context-memory/identity.js";
import { SessionLease } from "../packages/coding-agent/dist/extensions/context-memory/lease.js";
import { renderNote, validateNote } from "../packages/coding-agent/dist/extensions/context-memory/notes.js";
import { SessionStorage } from "../packages/coding-agent/dist/extensions/context-memory/storage.js";
import { writeMemory } from "../packages/coding-agent/dist/extensions/context-memory/writer.js";

const { values } = parseArgs({ options: {
	source: { type: "string" }, leaf: { type: "string" }, candidate: { type: "string" }, output: { type: "string" },
	"agent-dir": { type: "string" }, prepare: { type: "boolean" }, commit: { type: "string" },
	"confirm-complete-raw-history": { type: "boolean" }, reviewed: { type: "boolean" }, help: { type: "boolean" },
} });
if (values.help || (!values.source && !values.commit)) {
	console.log(`Inspect: node scripts/context-memory-migrate.mjs --source original.jsonl --leaf ENTRY_ID
Prepare a note for review (paid): add --prepare --confirm-complete-raw-history --candidate note.candidate.json
Commit a reviewed copy (no model call): --commit note.candidate.json --reviewed --output migrated.jsonl
The completeness flag asserts you have verified that the selected branch contains all original evidence.
Opaque replay recovery is intentionally not attempted by this command.`);
	process.exit(values.help ? 0 : 1);
}

function readBranch(file, leafId) {
	const bytes = readFileSync(file);
	const records = bytes.toString("utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
	if (records[0]?.type !== "session") throw new Error("Source has no valid session header");
	const byId = new Map();
	for (const entry of records.slice(1)) {
		if (!entry.id || byId.has(entry.id)) throw new Error("Source contains missing or duplicate entry IDs");
		byId.set(entry.id, entry);
	}
	const selected = leafId ?? records.at(-1)?.id;
	const branch = [];
	const seen = new Set();
	let current = selected;
	while (current) {
		const entry = byId.get(current);
		if (!entry || seen.has(current)) throw new Error("Source has a broken or cyclic ancestor chain");
		seen.add(current);
		branch.push(entry);
		current = entry.parentId;
	}
	branch.reverse();
	const raw = [];
	for (const entry of branch) {
		if (entry.type === "compaction") continue;
		raw.push({ ...entry, parentId: raw.at(-1)?.id ?? null });
	}
	const messages = raw.filter((entry) => entry.type === "message");
	if (messages[0]?.message.role !== "user") throw new Error("Source does not begin with an original user message; raw completeness is unresolved");
	const pending = new Set();
	for (const { message } of messages) {
		if (message.role === "assistant") {
			if (pending.size) throw new Error("Source is missing earlier tool results");
			for (const part of message.content ?? []) if (part.type === "toolCall") pending.add(part.id);
		} else if (message.role === "toolResult" && !pending.delete(message.toolCallId)) throw new Error("Source has an unmatched tool result");
	}
	if (pending.size) throw new Error("Wait for the source's current tool round to finish before migrating");
	return { header: records[0], branch, raw, leaf: selected, sourceHash: createHash("sha256").update(bytes).digest("hex") };
}

const candidate = values.commit ? JSON.parse(readFileSync(resolve(values.commit), "utf8")) : undefined;
if (values.prepare && values.commit) throw new Error("Choose preparation or commit, not both");
const source = resolve(candidate?.source ?? values.source);
const lease = values.prepare || values.commit ? SessionLease.acquire(source) : undefined;
try {
	const material = readBranch(source, candidate?.sourceLeaf ?? values.leaf);
	if (!values.prepare && !values.commit) {
		console.log(JSON.stringify({ sourceSha256: material.sourceHash, leaf: material.leaf, originalMessages: material.raw.filter((entry) => entry.type === "message").length, discardedCompactionRecords: material.branch.filter((entry) => entry.type === "compaction").length, rawCompleteness: "requires human confirmation; structural validity alone does not prove semantic completeness" }, null, 2));
	} else if (values.prepare) {
		if (!values.leaf || !values.candidate || !values["confirm-complete-raw-history"]) throw new Error("Preparation requires an explicit leaf, candidate path and confirmation of complete original evidence");
		const destination = resolve(values.candidate);
		if (existsSync(destination)) throw new Error("Candidate already exists; choose another path");
		const agentDir = resolve(values["agent-dir"] ?? getAgentDir());
		const config = readMemoryConfig(agentDir);
		const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), allowModelNetwork: false });
		const abort = new AbortController();
		const onInterrupt = () => abort.abort();
		process.once("SIGINT", onInterrupt);
		let result;
		try { result = await writeMemory({ config, runtime, increments: [], uncovered: material.raw, branch: material.raw, noteTokens: 6000, signal: abort.signal }); }
		finally { process.removeListener("SIGINT", onInterrupt); }
		lease.assert();
		if (readBranch(source, values.leaf).sourceHash !== material.sourceHash) throw new Error("Source changed while preparing; candidate discarded");
		const record = { version: 1, source, sourceSha256: material.sourceHash, sourceLeaf: material.leaf, writerModel: config.writerModel, note: result.note, usage: result.usage, chunkCount: result.chunkCount, build: CONTEXT_MEMORY_BUILD };
		mkdirSync(dirname(destination), { recursive: true });
		writeFileSync(destination, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
		writeFileSync(`${destination}.md`, `# Migration candidate for review\n\nOriginal SHA256: ${material.sourceHash}\nBranch: ${material.leaf}\n\nCheck current user rulings, failed attempts and their causes, and at least one early tool result against the original before committing.\n\n${renderNote(result.note)}\n`, { flag: "wx", mode: 0o600 });
		console.log(JSON.stringify({ candidate: destination, review: `${destination}.md`, usage: result.usage, originalChanged: false }, null, 2));
	} else {
		if (!values.reviewed || !values.output || candidate.version !== 1) throw new Error("Commit requires --reviewed and a new output path");
		if (candidate.sourceSha256 !== material.sourceHash || candidate.sourceLeaf !== material.leaf) throw new Error("Source changed since review; prepare and review again");
		validateNote(candidate.note, material.raw);
		const destination = resolve(values.output);
		if (existsSync(destination)) throw new Error("Output already exists; originals and previous copies are never overwritten");
		const header = { ...material.header, id: randomUUID(), version: 3, timestamp: new Date().toISOString(), parentSession: source };
		const memory = SessionManager.inMemory(header.cwd, undefined, [header, ...material.raw]);
		const firstKeptEntryId = material.raw[findCutPoint(material.raw, 0, material.raw.length, 20_000).firstKeptEntryIndex].id;
		const details = {
			kind: CONTEXT_MEMORY_KIND, version: 1, note: candidate.note, coveredThrough: memory.getLeafId(), sourceHash: hashEntries(material.raw),
			snapshot: { sessionId: header.id, leafId: memory.getLeafId(), lastCheckpointId: null }, writerModel: candidate.writerModel,
			chunkCount: candidate.chunkCount, build: candidate.build,
			migration: { sourceSha256: material.sourceHash, sourceLeafId: material.leaf, reviewedAt: new Date().toISOString() },
		};
		const tokensBefore = material.raw.flatMap(sessionEntryToContextMessages).reduce((sum, message) => sum + estimateTokens(message), 0);
		memory.appendCompaction(renderNote(candidate.note), firstKeptEntryId, tokensBefore, details, true, candidate.usage);
		mkdirSync(dirname(destination), { recursive: true });
		const storage = new SessionStorage();
		try { storage.withFile(destination, () => storage.replace([header, ...memory.getEntries()])); }
		finally { storage.close(); memory.close(); }
		console.log(JSON.stringify({ output: destination, sourceSha256: material.sourceHash, originalChanged: false, modelCalls: 0 }, null, 2));
	}
} finally { lease?.release(); }

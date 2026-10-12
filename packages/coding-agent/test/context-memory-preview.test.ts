import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	buildSessionProjection,
	type CompactionEntry,
	type ExtensionAPI,
	type ExtensionContext,
	estimateTokens,
	type SessionEntry,
	type SessionHeader,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MEMORY_CONFIG } from "../src/extensions/context-memory/config.ts";
import { freezeHistory, queryHistory } from "../src/extensions/context-memory/history.ts";
import { CONTEXT_MEMORY_KIND, CONTEXT_MEMORY_VERSION, hashEntries } from "../src/extensions/context-memory/identity.ts";
import {
	latestMemory,
	type MemoryCheckpoint,
	type MemoryNote,
	renderNote,
	validateNote,
} from "../src/extensions/context-memory/notes.ts";
import type { PreviewCompaction, PreviewSession } from "../src/extensions/context-memory/preview/contracts.ts";
import {
	assertPreviewSession,
	chooseCut,
	PreviewMemoryController,
	unsupportedReason,
} from "../src/extensions/context-memory/preview/controller.ts";
import contextMemoryPreview from "../src/extensions/context-memory/preview/extension.ts";
import { PreviewFailureStore } from "../src/extensions/context-memory/preview/failure-store.ts";
import { doctorReport } from "../src/extensions/context-memory/preview/notices.ts";

vi.mock("node:fs", async (original) => {
	const actual = await original<typeof fs>();
	return {
		...actual,
		renameSync: vi.fn(actual.renameSync),
		unlinkSync: vi.fn(actual.unlinkSync),
		fsyncSync: vi.fn(actual.fsyncSync),
	};
});
const originalFs = await vi.importActual<typeof fs>("node:fs");
const timestamp = "2026-01-01T00:00:00.000Z";
const sourceText = "Keep the synthetic service on port 4317. Do not change the deployment permission.";

function assistant(): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-completions",
		provider: "preview-test",
		model: "preview-test",
		content: [{ type: "text", text: "The synthetic decision is recorded." }],
		stopReason: "stop",
		timestamp: 1,
		usage: {
			input: 10,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 20,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

/** A public read-only session surface; no patched SessionManager is used in these tests. */
class SyntheticSession implements PreviewSession {
	readonly header: SessionHeader;
	entries: SessionEntry[] = [
		{
			type: "message",
			id: "source-1",
			parentId: null,
			timestamp,
			message: { role: "user", content: sourceText, timestamp: 0 },
		},
		{ type: "message", id: "reply-1", parentId: "source-1", timestamp, message: assistant() },
	];
	file: string | undefined;
	leafId: string | null = "reply-1";
	readonly root: string;
	constructor(root: string, id = "synthetic-session") {
		this.root = root;
		this.file = join(root, `${id}.jsonl`);
		this.header = { type: "session", version: 3, id, timestamp, cwd: root };
		this.persist();
	}
	persist(entries = this.entries): void {
		if (!this.file) throw new Error("Synthetic session has no persistence path");
		fs.writeFileSync(this.file, `${[this.header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	}
	getCwd() {
		return this.root;
	}
	getSessionDir() {
		return this.root;
	}
	getSessionId() {
		return this.header.id;
	}
	getSessionFile() {
		return this.file;
	}
	getLeafId() {
		return this.leafId;
	}
	getLeafEntry() {
		return this.entries.find((entry) => entry.id === this.leafId);
	}
	getEntry(id: string) {
		return this.entries.find((entry) => entry.id === id);
	}
	getLabel(_id: string) {
		return undefined;
	}
	getHeader() {
		return this.header;
	}
	getEntries() {
		return [...this.entries];
	}
	getTree() {
		return [];
	}
	getSessionName() {
		return undefined;
	}
	getBranch(fromId?: string): SessionEntry[] {
		let entry = this.getEntry(fromId ?? this.leafId ?? "");
		const branch: SessionEntry[] = [];
		const visited = new Set<string>();
		while (entry && !visited.has(entry.id)) {
			visited.add(entry.id);
			branch.unshift(entry);
			entry = this.getEntry(entry.parentId ?? "");
		}
		return branch;
	}
	buildContextEntries() {
		return this.getBranch();
	}
	buildSessionProjection() {
		return buildSessionProjection(this.getBranch());
	}
	append(entry: SessionEntry, persist = true): void {
		this.entries.push(entry);
		this.leafId = entry.id;
		if (persist) this.persist();
	}
}

function note(id = "source-1"): MemoryNote {
	return {
		instructions: [
			{ text: "Keep the deployment permission.", sources: [id], quote: "Do not change the deployment permission." },
		],
		failedPaths: [],
		reasons: [],
		state: [{ text: "The service uses port 4317.", sources: [id] }],
		nextSteps: [],
		files: [],
		gaps: [],
	};
}

function candidate(session: SyntheticSession): PreviewCompaction {
	const branch = session.getBranch();
	const details: MemoryCheckpoint = {
		kind: CONTEXT_MEMORY_KIND,
		version: CONTEXT_MEMORY_VERSION,
		note: note(),
		coveredThrough: session.getLeafId()!,
		sourceHash: hashEntries(branch),
		snapshot: {
			sessionId: session.getSessionId(),
			leafId: session.getLeafId(),
			lastCheckpointId: branch.findLast((entry) => entry.type === "compaction")?.id ?? null,
		},
		writerModel: "preview-test/preview-test",
		chunkCount: 1,
		build: "synthetic-preview",
	};
	return { summary: renderNote(details.note), firstKeptEntryId: session.getLeafId()!, tokensBefore: 2000, details };
}

function saved(session: SyntheticSession, value: PreviewCompaction): CompactionEntry<MemoryCheckpoint> {
	return {
		type: "compaction",
		id: "checkpoint-1",
		parentId: session.getLeafId(),
		timestamp,
		...value,
		fromHook: true,
	};
}

describe("independent extension preview: durable failure and commit boundary", () => {
	let root: string;
	let agentDir: string;
	let session: SyntheticSession;
	let store: PreviewFailureStore;
	beforeEach(() => {
		vi.mocked(fs.renameSync).mockReset().mockImplementation(originalFs.renameSync);
		vi.mocked(fs.unlinkSync).mockReset().mockImplementation(originalFs.unlinkSync);
		vi.mocked(fs.fsyncSync).mockReset().mockImplementation(originalFs.fsyncSync);
		root = fs.mkdtempSync(join(tmpdir(), "pi-preview-contract-"));
		agentDir = join(root, "agent");
		fs.mkdirSync(agentDir);
		session = new SyntheticSession(root);
		store = new PreviewFailureStore(agentDir);
	});
	afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
	function markerPath(): string {
		return join(
			agentDir,
			"context-memory-preview",
			"failures",
			`${createHash("sha256").update(session.getSessionId()).digest("hex")}.json`,
		);
	}
	function staged(): CompactionEntry<MemoryCheckpoint> {
		const attempt = store.begin(session, true);
		const value = candidate(session);
		store.stage(session, attempt, value);
		return saved(session, value);
	}
	function blocked(): void {
		expect(() => store.assertReady(session)).toThrow(/CONTEXT_/);
		expect(new PreviewFailureStore(agentDir).status(session).state).not.toBe("ready");
	}
	it("persists a pending attempt before generation and blocks a new store instance", () => {
		expect(store.status(session).state).toBe("ready");
		store.begin(session);
		expect(fs.existsSync(markerPath())).toBe(true);
		blocked();
	});
	it("keeps a failed attempt blocked across reconstruction and appended input", () => {
		store.begin(session);
		store.fail(session, "CONTEXT_NOTE_QUOTE");
		session.append({
			type: "message",
			id: "new-input",
			parentId: session.getLeafId(),
			timestamp,
			message: { role: "user", content: "Please continue anyway.", timestamp: 2 },
		});
		blocked();
		expect(new PreviewFailureStore(agentDir).status(session).code).toBe("CONTEXT_NOTE_QUOTE");
	});
	it("refuses an implicit retry without clearing the existing failure", () => {
		store.fail(session, "CONTEXT_WRITER_UNAVAILABLE");
		expect(() => new PreviewFailureStore(agentDir).begin(session)).toThrow(/CONTEXT_/);
		blocked();
	});
	it("an explicit retry remains pending until a matching checkpoint is confirmed on disk", () => {
		store.fail(session, "CONTEXT_WRITER_UNAVAILABLE");
		const entry = staged();
		blocked();
		session.append(entry);
		store.commit(session, entry);
		expect(new PreviewFailureStore(agentDir).status(session).state).toBe("ready");
		expect(fs.existsSync(markerPath())).toBe(false);
	});
	it("a failed explicit retry cannot clear an older failure", () => {
		store.fail(session, "CONTEXT_WRITER_UNAVAILABLE");
		store.begin(session, true);
		store.fail(session, "CONTEXT_NOTE_SCOPE");
		blocked();
	});
	it("does not accept a successful checkpoint event whose entry was never written", () => {
		const entry = staged();
		session.append(entry, false);
		expect(() => store.commit(session, entry)).toThrow(/CONTEXT_/);
		blocked();
	});
	it("does not clear an unstaged attempt even if a checkpoint exists on disk", () => {
		store.begin(session);
		const entry = saved(session, candidate(session));
		session.append(entry);
		expect(() => store.commit(session, entry)).toThrow(/CONTEXT_/);
		blocked();
	});
	it("refuses a checkpoint with a different note than the staged candidate", () => {
		const entry = staged();
		const altered = { ...entry, summary: `${entry.summary}\nUnverified extra sentence.` };
		session.append(altered);
		expect(() => store.commit(session, altered)).toThrow(/CONTEXT_/);
		blocked();
	});
	it("refuses an on-disk checkpoint that differs from the event entry", () => {
		const entry = staged();
		session.append(entry);
		session.persist(
			session.entries.map((value) =>
				value.id === entry.id ? { ...entry, tokensBefore: entry.tokensBefore + 1 } : value,
			),
		);
		expect(() => store.commit(session, entry)).toThrow(/CONTEXT_/);
		blocked();
	});
	it("rejects altered original evidence even when the saved checkpoint is unchanged", () => {
		const entry = staged();
		session.append(entry);
		session.persist(
			session.entries.map((value) =>
				value.id === "source-1" && value.type === "message"
					? { ...value, message: { role: "user", content: "Use port 9000 instead.", timestamp: 0 } }
					: value,
			),
		);
		expect(() => store.commit(session, entry)).toThrow(/CONTEXT_/);
		blocked();
	});
	it("rejects a changed in-memory snapshot before staging", () => {
		const attempt = store.begin(session);
		const value = candidate(session);
		session.append({
			type: "message",
			id: "changed-source",
			parentId: session.getLeafId(),
			timestamp,
			message: { role: "user", content: "The decision changed.", timestamp: 2 },
		});
		expect(() => store.stage(session, attempt, value)).toThrow(/CONTEXT_/);
		blocked();
	});
	it("rejects a checkpoint with a broken parent chain", () => {
		const entry = staged();
		const orphan = { ...entry, parentId: "absent-parent" };
		session.append(orphan);
		expect(() => store.commit(session, orphan)).toThrow(/CONTEXT_/);
		blocked();
	});
	it("rejects a different session header at the same disk path", () => {
		const entry = staged();
		session.append(entry);
		fs.writeFileSync(
			session.file!,
			`${JSON.stringify({ ...session.header, id: "different-session" })}\n${session.entries.map((value) => JSON.stringify(value)).join("\n")}\n`,
		);
		expect(() => store.commit(session, entry)).toThrow(/CONTEXT_/);
		blocked();
	});
	it("isolates operational failures from an unrelated session", () => {
		store.fail(session, "CONTEXT_NOTE_QUOTE");
		const unrelated = new SyntheticSession(root, "unrelated-session");
		expect(() => new PreviewFailureStore(agentDir).assertReady(unrelated)).not.toThrow();
		blocked();
	});
	it("does not store source text, quotes, note prose or a raw error in the operational marker", () => {
		const entry = staged();
		store.fail(session, "CONTEXT_WRITER_FAILED: synthetic-private-auth=secret-value");
		const raw = fs.readFileSync(markerPath(), "utf8");
		for (const privateText of [
			sourceText,
			"synthetic-private-auth",
			"secret-value",
			entry.summary,
			JSON.stringify(entry.details?.note),
		])
			expect(raw).not.toContain(privateText);
		blocked();
	});
	it("fails closed on a corrupt marker after restart", () => {
		store.begin(session);
		fs.writeFileSync(markerPath(), "{broken JSON");
		expect(() => new PreviewFailureStore(agentDir).assertReady(session)).toThrow(/CONTEXT_/);
	});
	it("fails closed when a marker path is a directory", () => {
		store.begin(session);
		fs.unlinkSync(markerPath());
		fs.mkdirSync(markerPath());
		expect(() => new PreviewFailureStore(agentDir).assertReady(session)).toThrow(/CONTEXT_/);
	});
	it("does not follow a marker symlink to another session's state", () => {
		store.begin(session);
		fs.unlinkSync(markerPath());
		const target = join(root, "outside-marker.json");
		fs.writeFileSync(target, "{}");
		fs.symlinkSync(target, markerPath());
		expect(() => new PreviewFailureStore(agentDir).assertReady(session)).toThrow(/CONTEXT_/);
		expect(fs.readFileSync(target, "utf8")).toBe("{}");
	});
	it("refuses in-memory sessions as a persistent protection surface", () => {
		session.file = undefined;
		expect(() => store.assertReady(session)).toThrow(/CONTEXT_/);
		expect(() => store.begin(session, true)).toThrow(/CONTEXT_/);
	});
	it("an interrupted marker write fails closed in the current instance", () => {
		vi.mocked(fs.renameSync).mockImplementationOnce(() => {
			throw Object.assign(new Error("Synthetic marker write failure"), { code: "ENOSPC" });
		});
		expect(() => store.begin(session)).toThrow(/CONTEXT_/);
		expect(() => store.assertReady(session)).toThrow(/CONTEXT_/);
	});
	it("a failed marker removal cannot turn a confirmed commit into ready state", () => {
		const entry = staged();
		session.append(entry);
		vi.mocked(fs.unlinkSync).mockImplementationOnce(() => {
			throw Object.assign(new Error("Synthetic marker removal failure"), { code: "EACCES" });
		});
		expect(() => store.commit(session, entry)).toThrow(/CONTEXT_/);
		blocked();
	});
	it("an explicit recovery confirms an unobserved staged disk commit after restart", () => {
		const entry = staged();
		session.append(entry);
		blocked();
		new PreviewFailureStore(agentDir).recover(session, entry);
		expect(new PreviewFailureStore(agentDir).status(session).state).toBe("ready");
	});
	it("explicit recovery may confirm a previously blocked staged commit after IO is repaired", () => {
		const entry = staged();
		session.append(entry);
		vi.mocked(fs.unlinkSync).mockImplementationOnce(() => {
			throw Object.assign(new Error("Synthetic marker removal failure"), { code: "EACCES" });
		});
		expect(() => store.commit(session, entry)).toThrow(/CONTEXT_/);
		new PreviewFailureStore(agentDir).recover(session, entry);
		expect(new PreviewFailureStore(agentDir).status(session).state).toBe("ready");
	});
	it("a successful unlink followed by directory fsync failure preserves staged recovery evidence", () => {
		const entry = staged();
		session.append(entry);
		vi.mocked(fs.fsyncSync).mockImplementationOnce(() => {
			throw Object.assign(new Error("Synthetic post-unlink directory fsync failure"), { code: "ENOSPC" });
		});
		expect(() => store.commit(session, entry)).toThrow(/CONTEXT_/);
		blocked();
		new PreviewFailureStore(agentDir).recover(session, entry);
		expect(new PreviewFailureStore(agentDir).status(session).state).toBe("ready");
	});
	it("explicit recovery cannot turn an unstaged writer failure into success", () => {
		store.begin(session);
		const entry = saved(session, candidate(session));
		session.append(entry);
		store.fail(session, "CONTEXT_WRITER_FAILED");
		expect(() => new PreviewFailureStore(agentDir).recover(session, entry)).toThrow(/CONTEXT_/);
		blocked();
	});
	it("explicit recovery rejects a staged checkpoint whose saved candidate hash changed", () => {
		const entry = staged();
		const changed = { ...entry, summary: `${entry.summary}\nFabricated extra instruction.` };
		session.append(changed);
		expect(() => new PreviewFailureStore(agentDir).recover(session, changed)).toThrow(/CONTEXT_/);
		blocked();
	});
	it("explicit recovery requires the checkpoint to remain the current leaf", () => {
		const entry = staged();
		session.append(entry);
		session.append({
			type: "message",
			id: "after-checkpoint",
			parentId: entry.id,
			timestamp,
			message: { role: "user", content: "Continue.", timestamp: 2 },
		});
		expect(() => new PreviewFailureStore(agentDir).recover(session, entry)).toThrow(/CONTEXT_/);
		blocked();
	});
	it("explicit recovery rejects a checkpoint present only in memory", () => {
		const entry = staged();
		session.append(entry, false);
		expect(() => new PreviewFailureStore(agentDir).recover(session, entry)).toThrow(/CONTEXT_/);
		blocked();
	});
	it("a same-ID session copy at another path cannot confirm or remove the original marker", () => {
		const entry = staged();
		session.append(entry);
		const copyRoot = join(root, "copy");
		fs.mkdirSync(copyRoot);
		const copy = new SyntheticSession(copyRoot, session.getSessionId());
		copy.entries = structuredClone(session.entries);
		copy.leafId = session.leafId;
		copy.persist();
		expect(() => new PreviewFailureStore(agentDir).recover(copy, entry)).toThrow(/CONTEXT_/);
		expect(fs.existsSync(markerPath())).toBe(true);
		blocked();
	});
	it("a stage fsync failure leaves the earlier pending marker blocked across reconstruction", () => {
		const attempt = store.begin(session);
		vi.mocked(fs.fsyncSync).mockImplementationOnce(() => {
			throw Object.assign(new Error("Synthetic stage fsync failure"), { code: "ENOSPC" });
		});
		expect(() => store.stage(session, attempt, candidate(session))).toThrow(/CONTEXT_/);
		blocked();
	});
	it("refuses damaged session JSONL even when no previous failure marker exists", () => {
		fs.writeFileSync(session.file!, `${JSON.stringify(session.header)}\n{truncated original`);
		expect(() => new PreviewFailureStore(agentDir).assertReady(session)).toThrow(/CONTEXT_/);
	});
});

describe("independent extension preview: evidence validation", () => {
	let root: string;
	let session: SyntheticSession;
	beforeEach(() => {
		root = fs.mkdtempSync(join(tmpdir(), "pi-preview-evidence-"));
		session = new SyntheticSession(root);
	});
	afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
	it("rejects a quotation found in a different entry but not the cited original", () => {
		const wrong = note("reply-1");
		expect(() => validateNote(wrong, session.getBranch())).toThrow(/CONTEXT_NOTE_QUOTE/);
	});
	it("rejects an unreadable supersedes ID even when it exists on the branch", () => {
		session.append({
			type: "thinking_level_change",
			id: "state-only",
			parentId: session.getLeafId(),
			timestamp,
			thinkingLevel: "off",
		});
		const wrong = note();
		wrong.state[0].supersedes = ["state-only"];
		expect(() => validateNote(wrong, session.getBranch())).toThrow(/CONTEXT_NOTE_SCOPE/);
	});
	it("rejects a fabricated citation", () => {
		expect(() => validateNote(note("invented-id"), session.getBranch())).toThrow(/CONTEXT_NOTE_SCOPE/);
	});
	it("requires a complete structured note rather than plausible prose", () => {
		expect(() => validateNote({ state: note().state }, session.getBranch())).toThrow(/CONTEXT_NOTE_INVALID/);
	});
	it("does not retrieve an entry from a sibling branch", () => {
		session.entries.push({
			type: "message",
			id: "sibling-private",
			parentId: "source-1",
			timestamp,
			message: { role: "user", content: "Sibling-only material.", timestamp: 2 },
		});
		expect(() => queryHistory(freezeHistory(session), { operation: "read", entryId: "sibling-private" })).toThrow(
			/HISTORY_SCOPE_DENIED/,
		);
	});
	it("rejects a restored checkpoint whose original evidence was modified", () => {
		const entry = saved(session, candidate(session));
		session.append(entry);
		const source = session.entries.find((value) => value.id === "source-1");
		if (source?.type !== "message" || source.message.role !== "user") throw new Error("Missing synthetic source");
		source.message.content = "Modified decision.";
		expect(() => latestMemory(session.getBranch())).toThrow(/CONTEXT_SOURCE_CHANGED/);
	});
});

describe("independent extension preview: Pi recovery edits", () => {
	let root: string;
	let session: SyntheticSession;
	beforeEach(() => {
		root = fs.mkdtempSync(join(tmpdir(), "pi-preview-retry-"));
		session = new SyntheticSession(root);
	});
	afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
	function retry(): void {
		session.append({
			type: "message",
			id: "retry-input",
			parentId: session.getLeafId(),
			timestamp,
			message: { role: "user", content: "Continue the local check.", timestamp: 2 },
		});
		session.append({
			type: "message",
			id: "failed-reply",
			parentId: session.getLeafId(),
			timestamp,
			message: { ...assistant(), stopReason: "error", content: [{ type: "text", text: "Partial failed reply." }] },
		});
		session.append({
			type: "context_edit",
			id: "recovery-edit",
			parentId: session.getLeafId(),
			timestamp,
			targetId: "failed-reply",
			replacement: null,
		});
	}
	function checkpoint(): void {
		const value = candidate(session);
		value.details!.build = "stock-preview+test";
		session.append(saved(session, value));
	}
	it("accepts a failed-response omission while retaining the original history", () => {
		retry();
		expect(() => assertPreviewSession(session)).not.toThrow();
		expect(JSON.stringify(session.buildSessionProjection().messages)).not.toContain("Partial failed reply.");
		expect(
			JSON.stringify(queryHistory(freezeHistory(session), { operation: "read", entryId: "failed-reply" })),
		).toContain("Partial failed reply.");
	});
	it("keeps an earlier recovery edit valid after a later checkpoint", () => {
		retry();
		checkpoint();
		expect(() => assertPreviewSession(session)).not.toThrow();
		const failed = session.getEntry("failed-reply");
		if (failed?.type !== "message" || failed.message.role !== "assistant") throw new Error("Missing failed reply");
		failed.message.content = [{ type: "text", text: "Changed original evidence." }];
		expect(() => assertPreviewSession(session)).toThrow(/CONTEXT_SOURCE_CHANGED/);
	});
	it.each(["source-1", "reply-1", "missing", "sibling"])("rejects an omission targeting %s", (targetId) => {
		retry();
		session.entries.push({
			type: "message",
			id: "sibling",
			parentId: "reply-1",
			timestamp,
			message: { ...assistant(), stopReason: "error" },
		});
		const edit = session.getEntry("recovery-edit");
		if (edit?.type !== "context_edit") throw new Error("Missing recovery edit");
		edit.targetId = targetId;
		expect(() => assertPreviewSession(session)).toThrow(/CONTEXT_PREVIEW_UNSUPPORTED/);
	});
	it("rejects replacement content even for a failed assistant response", () => {
		retry();
		const edit = session.getEntry("recovery-edit");
		if (edit?.type !== "context_edit") throw new Error("Missing recovery edit");
		edit.replacement = { content: "New instructions." };
		expect(() => assertPreviewSession(session)).toThrow(/CONTEXT_PREVIEW_UNSUPPORTED/);
	});
	it.each(["stop", "length", "aborted"] as const)("rejects omissions of a response ending with %s", (stopReason) => {
		retry();
		const failed = session.getEntry("failed-reply");
		if (failed?.type !== "message" || failed.message.role !== "assistant") throw new Error("Missing failed reply");
		failed.message.stopReason = stopReason;
		expect(() => assertPreviewSession(session)).toThrow(/CONTEXT_PREVIEW_UNSUPPORTED/);
	});
	it("rejects an omission after a new user request has arrived", () => {
		retry();
		session.append({
			type: "message",
			id: "new-request",
			parentId: session.getLeafId(),
			timestamp,
			message: { role: "user", content: "A separate request.", timestamp: 3 },
		});
		session.append({
			type: "context_edit",
			id: "unrelated-edit",
			parentId: session.getLeafId(),
			timestamp,
			targetId: "failed-reply",
			replacement: null,
		});
		expect(() => assertPreviewSession(session)).toThrow(/CONTEXT_PREVIEW_UNSUPPORTED/);
	});
	it("rejects a forward reference to a later response", () => {
		session.append({
			type: "context_edit",
			id: "forward-edit",
			parentId: session.getLeafId(),
			timestamp,
			targetId: "future-reply",
			replacement: null,
		});
		session.append({
			type: "message",
			id: "future-reply",
			parentId: session.getLeafId(),
			timestamp,
			message: { ...assistant(), stopReason: "error" },
		});
		expect(() => assertPreviewSession(session)).toThrow(/CONTEXT_PREVIEW_UNSUPPORTED/);
	});
	it("does not clear pending or failed compaction state when a recovery edit is valid", () => {
		const agentDir = join(root, "agent");
		fs.mkdirSync(agentDir);
		const store = new PreviewFailureStore(agentDir);
		store.begin(session);
		retry();
		expect(() => assertPreviewSession(session)).not.toThrow();
		expect(store.status(session).state).toBe("pending");
		expect(() => store.assertReady(session)).toThrow(/CONTEXT_PREVIEW_PENDING/);
		store.fail(session, "CONTEXT_WRITER_FAILED");
		expect(() => assertPreviewSession(session)).not.toThrow();
		expect(() => new PreviewFailureStore(agentDir).assertReady(session)).toThrow(/CONTEXT_WRITER_FAILED/);
	});
	it("rejects a failed response that contains a tool call", () => {
		retry();
		const failed = session.getEntry("failed-reply");
		if (failed?.type !== "message" || failed.message.role !== "assistant") throw new Error("Missing failed reply");
		failed.message.content = [{ type: "toolCall", id: "unfinished", name: "read", arguments: {} }];
		expect(() => assertPreviewSession(session)).toThrow(/CONTEXT_PREVIEW_UNSUPPORTED/);
	});
	it("rejects an edit crossing a checkpoint that already existed when it was appended", () => {
		retry();
		checkpoint();
		session.append({
			type: "context_edit",
			id: "late-edit",
			parentId: session.getLeafId(),
			timestamp,
			targetId: "failed-reply",
			replacement: null,
		});
		expect(() => assertPreviewSession(session)).toThrow(/CONTEXT_PREVIEW_UNSUPPORTED/);
	});
	it("counts only projected messages when retaining complete recent turns", () => {
		retry();
		const failed = session.getEntry("failed-reply");
		if (failed?.type !== "message" || failed.message.role !== "assistant") throw new Error("Missing failed reply");
		failed.message.content = [{ type: "text", text: "omitted ".repeat(1000) }];
		session.append({
			type: "message",
			id: "later-input",
			parentId: session.getLeafId(),
			timestamp,
			message: { role: "user", content: "Another local check.", timestamp: 3 },
		});
		session.append({
			type: "message",
			id: "later-reply",
			parentId: session.getLeafId(),
			timestamp,
			message: assistant(),
		});
		const branch = session.getBranch();
		const budget = session
			.buildSessionProjection()
			.entries.filter((entry) => ["retry-input", "later-input", "later-reply"].includes(entry.sourceEntry.id))
			.flatMap((entry) => entry.messages)
			.reduce((sum, message) => sum + estimateTokens(message), 0);
		expect(chooseCut(branch, budget)).toBe(branch.findIndex((entry) => entry.id === "retry-input"));
	});
});

describe("independent extension preview: sessions it does not protect", () => {
	type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
	let root: string;
	let agentDir: string;
	let session: SyntheticSession;
	let warnings: string[];
	let previousAgentDir: string | undefined;
	const model = {
		id: "preview-test",
		name: "Preview test",
		provider: "preview-test",
		api: "openai-completions",
		baseUrl: "http://127.0.0.1:9/v1",
		reasoning: false,
		input: ["text"],
		contextWindow: 128_000,
		maxTokens: 8192,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	beforeEach(() => {
		root = fs.mkdtempSync(join(tmpdir(), "pi-preview-protection-"));
		agentDir = join(root, "agent");
		fs.mkdirSync(agentDir);
		session = new SyntheticSession(root);
		warnings = [];
		vi.spyOn(console, "warn").mockImplementation((text: unknown) => {
			warnings.push(String(text));
		});
		previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
	});
	afterEach(() => {
		vi.restoreAllMocks();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(root, { recursive: true, force: true });
	});
	function context(abort = vi.fn()): ExtensionContext {
		const value = {
			sessionManager: session,
			hasUI: false,
			ui: { notify: vi.fn() },
			abort,
			model,
			modelRegistry: { find: () => undefined, hasConfiguredAuth: () => false },
			thinkingLevel: "off",
			getSystemPrompt: () => "Synthetic system prompt.",
			getContextUsage: () => ({ tokens: 1234, contextWindow: 128_000, percent: 1 }),
			hasPendingMessages: () => false,
			waitForIdle: async () => {},
		};
		return value as unknown as ExtensionContext;
	}
	function controller(options: { configError?: string; hostVersion?: string } = {}) {
		return new PreviewMemoryController({
			config: options.configError ? undefined : DEFAULT_MEMORY_CONFIG,
			configError: options.configError,
			failureStore: new PreviewFailureStore(agentDir),
			hostVersion: options.hostVersion,
		});
	}
	function markerPath(): string {
		return join(
			agentDir,
			"context-memory-preview",
			"failures",
			`${createHash("sha256").update(session.getSessionId()).digest("hex")}.json`,
		);
	}
	function messages(): AgentMessage[] {
		return session.buildSessionProjection().messages;
	}
	function addImage(): void {
		session.append({
			type: "message",
			id: "image-input",
			parentId: session.getLeafId(),
			timestamp,
			message: {
				role: "user",
				content: [
					{ type: "text", text: "What does this show?" },
					{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
				],
				timestamp: 3,
			},
		});
	}
	function addNativeCheckpoint(): void {
		session.append({
			type: "compaction",
			id: "native-checkpoint",
			parentId: session.getLeafId(),
			timestamp,
			summary: "Synthetic native summary.",
			firstKeptEntryId: "source-1",
			tokensBefore: 100,
		});
	}
	function protect(): void {
		const value = candidate(session);
		value.details!.build = "stock-preview+test";
		session.append(saved(session, value));
	}
	function loadPreview(): Map<string, Handler[]> {
		const handlers = new Map<string, Handler[]>();
		const pi = {
			registerCommand: () => {},
			registerTool: () => {},
			on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
			getActiveTools: () => [],
			getAllTools: () => [],
			appendEntry: () => {},
		};
		contextMemoryPreview(pi as unknown as ExtensionAPI);
		return handlers;
	}
	async function emit(handlers: Map<string, Handler[]>, event: string, value: unknown, ctx: ExtensionContext) {
		let result: unknown;
		for (const handler of handlers.get(event) ?? []) result = await handler(value, ctx);
		return result;
	}

	it("classifies host, persistence and content it cannot check", () => {
		expect(unsupportedReason(session)).toBeUndefined();
		expect(unsupportedReason(session, "1.0.4")).toBe("host");
		const file = session.file;
		session.file = undefined;
		expect(unsupportedReason(session)).toBe("in-memory");
		session.file = file;
		addImage();
		expect(unsupportedReason(session)).toBe("image");
		expect(() => assertPreviewSession(session)).toThrow(/CONTEXT_PREVIEW_UNSUPPORTED/);
	});
	it("classifies a native checkpoint as foreign and keeps the migration error", () => {
		addNativeCheckpoint();
		expect(unsupportedReason(session)).toBe("foreign-checkpoint");
		expect(() => assertPreviewSession(session)).toThrow(/CONTEXT_MIGRATION_REQUIRED/);
	});
	it("stands aside in an image session it never enrolled: no abort, no marker, one notice", () => {
		addImage();
		const preview = controller();
		const abort = vi.fn();
		const ctx = context(abort);
		const input = messages();
		expect(preview.context(input, ctx)).toBe(input);
		preview.context(input, ctx);
		preview.beforeRequest({ messages: [] }, ctx);
		preview.notices.nextEpisode();
		preview.context(input, ctx);
		expect(abort).not.toHaveBeenCalled();
		expect(fs.existsSync(markerPath())).toBe(false);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("image");
		expect(warnings[0]).not.toContain("/compact");
		expect(preview.status(ctx)).toMatchObject({ state: "inactive", protection: "not-protected", reason: "image" });
	});
	it("does not write a marker when Pi compacts a session it does not protect", () => {
		addNativeCheckpoint();
		const preview = controller();
		const ctx = context();
		preview.committed(
			{
				type: "session_compact",
				compactionEntry: session.getLeafEntry() as CompactionEntry,
				fromExtension: false,
				reason: "manual",
				willRetry: false,
			},
			ctx,
		);
		expect(fs.existsSync(markerPath())).toBe(false);
		expect(preview.protected(ctx)).toBe(false);
	});
	it("keeps a protected session strict when an image appears, with one notice per input", () => {
		protect();
		addImage();
		const preview = controller();
		const abort = vi.fn();
		const ctx = context(abort);
		preview.context(messages(), ctx);
		preview.context(messages(), ctx);
		preview.beforeRequest({ messages: [] }, ctx);
		expect(abort).toHaveBeenCalledTimes(3);
		expect(JSON.parse(fs.readFileSync(markerPath(), "utf8"))).toMatchObject({
			state: "blocked",
			code: "CONTEXT_PREVIEW_UNSUPPORTED",
		});
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("image");
		expect(warnings[0]).not.toContain("/compact");
		preview.notices.nextEpisode();
		preview.context(messages(), ctx);
		expect(warnings).toHaveLength(2);
		expect(preview.status(ctx)).toMatchObject({ state: "blocked", protection: "protected", reason: "image" });
	});
	it("an unsupported host leaves unenrolled sessions alone but keeps a recorded block", () => {
		const preview = controller({ hostVersion: "1.0.4" });
		const abort = vi.fn();
		const ctx = context(abort);
		preview.context(messages(), ctx);
		expect(abort).not.toHaveBeenCalled();
		expect(fs.existsSync(markerPath())).toBe(false);
		new PreviewFailureStore(agentDir).fail(session, "CONTEXT_NOTE_QUOTE");
		preview.context(messages(), ctx);
		expect(abort).toHaveBeenCalledTimes(1);
		expect(new PreviewFailureStore(agentDir).status(session).code).toBe("CONTEXT_NOTE_QUOTE");
	});
	it("an unreadable configuration stops requests without durably blocking an unenrolled session", () => {
		const preview = controller({ configError: "CONTEXT_CONFIG" });
		const abort = vi.fn();
		const ctx = context(abort);
		preview.context(messages(), ctx);
		preview.beforeRequest({ messages: [] }, ctx);
		expect(abort).toHaveBeenCalledTimes(2);
		expect(fs.existsSync(markerPath())).toBe(false);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("pi-context-memory.json");
		expect(warnings[0]).toContain("no lasting block is recorded");
	});
	it("fails closed when the session cannot be classified during a failed guard", () => {
		const preview = controller({ configError: "CONTEXT_CONFIG" });
		const abort = vi.fn();
		session.getEntries = () => {
			throw new Error("synthetic classification failure");
		};
		preview.context(messages(), context(abort));
		expect(abort).toHaveBeenCalledTimes(1);
		expect(JSON.parse(fs.readFileSync(markerPath(), "utf8"))).toMatchObject({ code: "CONTEXT_CONFIG" });
	});
	it("/compaction-recover with nothing staged never creates a block", () => {
		const preview = controller();
		const ctx = context();
		expect(() => preview.recover(ctx)).toThrow(/CONTEXT_PREVIEW_COMMIT_UNCONFIRMED/);
		expect(fs.existsSync(markerPath())).toBe(false);
		protect();
		expect(() => preview.recover(ctx)).toThrow(/CONTEXT_PREVIEW_COMMIT_UNCONFIRMED/);
		expect(fs.existsSync(markerPath())).toBe(false);
		expect(preview.status(ctx)).toMatchObject({ state: "ready", protection: "protected" });
	});
	it("a refused /compaction-recover keeps the earlier failure and its code", () => {
		const preview = controller();
		const ctx = context();
		new PreviewFailureStore(agentDir).fail(session, "CONTEXT_NOTE_QUOTE");
		expect(() => preview.recover(ctx)).toThrow(/CONTEXT_PREVIEW_COMMIT_UNCONFIRMED/);
		expect(JSON.parse(fs.readFileSync(markerPath(), "utf8"))).toMatchObject({
			state: "blocked",
			code: "CONTEXT_NOTE_QUOTE",
		});
		expect(preview.status(ctx)).toMatchObject({ state: "blocked", code: "CONTEXT_NOTE_QUOTE" });
	});
	it("an unreadable configuration still records a durable block in a protected session", () => {
		protect();
		const preview = controller({ configError: "CONTEXT_CONFIG" });
		const abort = vi.fn();
		preview.context(messages(), context(abort));
		expect(abort).toHaveBeenCalledTimes(1);
		expect(JSON.parse(fs.readFileSync(markerPath(), "utf8"))).toMatchObject({ code: "CONTEXT_CONFIG" });
	});
	it("status keeps its fields and reports Pi's manual gate as unknown; a pending attempt reads as pending", () => {
		const preview = controller();
		const ctx = context();
		expect(preview.status(ctx)).toMatchObject({
			state: "ready",
			enabled: true,
			writerModel: "session",
			writer: "preview-test/preview-test",
			noteBudgetMode: "tiered",
			manualOnly: true,
			protection: "eligible",
			manualCompaction: { preview: "ready", pi: "unknown", contextTokens: 1234 },
		});
		new PreviewFailureStore(agentDir).begin(session);
		expect(preview.status(ctx)).toMatchObject({
			state: "pending",
			code: "CONTEXT_PREVIEW_PENDING",
			protection: "protected",
		});
	});
	it("the doctor reads without creating marker state and states each condition separately", () => {
		const preview = controller();
		const report = doctorReport(preview.diagnose(context()), { disabled: false, writerModel: "session" });
		expect(fs.existsSync(join(agentDir, "context-memory-preview"))).toBe(false);
		for (const label of ["extension: ok", "host: ok", "session: ok", "writer: ok", "durable block: ok"])
			expect(report).toContain(label);
		expect(report).toMatch(/manual \/compact: unknown/);
		expect(report).toContain("Nothing to compact (session too small)");
		expect(report).toContain("Result: ready");
	});
	it("does not latch a damaged session file into the process when only inspected", () => {
		fs.writeFileSync(session.file!, `${JSON.stringify(session.header)}\n{truncated original`);
		const store = new PreviewFailureStore(agentDir);
		expect(store.inspect(session).state).toBe("blocked");
		fs.writeFileSync(session.file!, "");
		session.persist();
		expect(store.inspect(session).state).toBe("ready");
	});
	it("automatic compaction is cancelled with an actionable code and reported once per input", async () => {
		const handlers = loadPreview();
		const abort = vi.fn();
		const ctx = context(abort);
		const event = {
			type: "session_before_compact",
			preparation: { tokensBefore: 115_000 },
			branchEntries: session.getBranch(),
			reason: "threshold",
			willRetry: false,
			signal: new AbortController().signal,
		};
		await emit(handlers, "input", { type: "input", text: "Continue.", source: "interactive" }, ctx);
		expect(await emit(handlers, "session_before_compact", event, ctx)).toEqual({ cancel: true });
		await emit(handlers, "session_compact_failed", { type: "session_compact_failed", aborted: true }, ctx);
		await emit(handlers, "context", { type: "context", messages: messages() }, ctx);
		await emit(handlers, "context_with_system", { type: "context_with_system", messages: messages() }, ctx);
		expect(JSON.parse(fs.readFileSync(markerPath(), "utf8"))).toMatchObject({
			state: "blocked",
			code: "CONTEXT_PREVIEW_COMPACT_REQUIRED",
		});
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("/compact");
		expect(warnings[0]).not.toContain("UNSUPPORTED");
		await emit(handlers, "input", { type: "input", text: "Continue again.", source: "interactive" }, ctx);
		await emit(handlers, "context", { type: "context", messages: messages() }, ctx);
		expect(warnings).toHaveLength(2);
	});
	it("leaves compaction and cache warming to Pi only where it does not protect the session", async () => {
		const handlers = loadPreview();
		const ctx = context();
		const event = {
			type: "session_before_compact",
			preparation: { tokensBefore: 115_000 },
			branchEntries: session.getBranch(),
			reason: "threshold",
			willRetry: false,
			signal: new AbortController().signal,
		};
		const warming = { type: "cache_warming_decision", action: "warm" };
		expect(await emit(handlers, "cache_warming_decision", warming, ctx)).toEqual({ action: "stop" });
		addNativeCheckpoint();
		expect(await emit(handlers, "cache_warming_decision", warming, ctx)).toBeUndefined();
		expect(await emit(handlers, "session_before_compact", event, ctx)).toBeUndefined();
		expect(fs.existsSync(markerPath())).toBe(false);
	});
});

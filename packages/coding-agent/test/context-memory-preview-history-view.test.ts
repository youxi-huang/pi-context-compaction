import { buildSessionProjection, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { textTokens } from "../src/extensions/context-memory/config.ts";
import { type HistorySnapshot, queryHistory } from "../src/extensions/context-memory/history.ts";
import { CONTEXT_MEMORY_KIND, CONTEXT_MEMORY_VERSION } from "../src/extensions/context-memory/identity.ts";
import { hashEntries, type MemoryNote, type NoteFact, sourceText } from "../src/extensions/context-memory/notes.ts";
import {
	type EditViewItem,
	type ErrorViewItem,
	inContextEntries,
	LOW_DETAIL_TOKENS,
	listHistory,
	type NoteViewItem,
	previewHistorySchema,
	priceSearch,
	readLowDetail,
	viewTerms,
} from "../src/extensions/context-memory/preview/history-view.ts";

const timestamp = "2026-01-01T00:00:00.000Z";
const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

class Branch {
	readonly entries: SessionEntry[] = [];

	private push(entry: SessionEntry): string {
		this.entries.push(entry);
		return entry.id;
	}

	private next(id: string) {
		return { id, parentId: this.entries.at(-1)?.id ?? null, timestamp };
	}

	user(id: string, text: string): string {
		return this.push({ type: "message", ...this.next(id), message: { role: "user", content: text, timestamp: 1 } });
	}

	assistant(id: string, text: string, calls: { id: string; name: string; path?: string }[] = []): string {
		const args = (path?: string): Record<string, string> =>
			path === undefined ? { content: "x" } : { content: "x", path };
		return this.push({
			type: "message",
			...this.next(id),
			message: {
				role: "assistant",
				content: [
					{ type: "text", text },
					...calls.map((call) => ({
						type: "toolCall" as const,
						id: call.id,
						name: call.name,
						arguments: args(call.path),
					})),
				],
				api: "openai-completions",
				provider: "synthetic",
				model: "view",
				stopReason: calls.length ? "toolUse" : "stop",
				timestamp: 1,
				usage,
			},
		});
	}

	result(id: string, toolCallId: string, toolName: string, text: string, isError = false): string {
		return this.push({
			type: "message",
			...this.next(id),
			message: {
				role: "toolResult",
				toolCallId,
				toolName,
				content: [{ type: "text", text }],
				isError,
				timestamp: 1,
			},
		});
	}

	bash(id: string, command: string, output: string, exitCode: number | undefined): string {
		return this.push({
			type: "message",
			...this.next(id),
			message: {
				role: "bashExecution",
				command,
				output,
				exitCode,
				cancelled: false,
				truncated: false,
				timestamp: 1,
			},
		});
	}

	checkpoint(id: string, note: Partial<MemoryNote>): string {
		const full: MemoryNote = {
			instructions: [],
			failedPaths: [],
			reasons: [],
			state: [{ text: "Working.", sources: [this.entries[0].id] }],
			nextSteps: [],
			files: [],
			gaps: [],
			...note,
		};
		return this.push({
			type: "compaction",
			...this.next(id),
			summary: "Context memory.",
			firstKeptEntryId: "context-memory:keep-none",
			tokensBefore: 1,
			details: { kind: CONTEXT_MEMORY_KIND, version: CONTEXT_MEMORY_VERSION, note: full },
		});
	}

	snapshot(): HistorySnapshot {
		return {
			sessionId: "view-session",
			leafId: this.entries.at(-1)?.id ?? null,
			scopeHash: hashEntries(this.entries),
			entries: this.entries,
		};
	}
}

const fact = (text: string, sources: string[], extra: Partial<NoteFact> = {}): NoteFact => ({
	text,
	sources,
	...extra,
});

/** A timeout set, revised twice and reverted, across two checkpoints. */
function revisions(): Branch {
	const branch = new Branch();
	branch.user("u1", "Set the request timeout to 100 ms.");
	branch.assistant("a1", "Timeout set to 100 ms.");
	branch.user("u2", "Raise the timeout to 200 ms.");
	branch.assistant("a2", "Done.");
	branch.checkpoint("cp1", {
		instructions: [fact("Leave vendor/ unchanged.", ["u1"])],
		reasons: [
			fact("Timeout is 100 ms.", ["u1"], { quote: "Set the request timeout to 100 ms." }),
			fact("Timeout raised to 200 ms.", ["u2"], { supersedes: ["u1"] }),
		],
	});
	branch.user("u3", "Make the timeout 300 ms.");
	branch.assistant("a3", "Done.");
	branch.user("u4", "Go back to a 100 ms timeout; 300 was too slow.");
	branch.assistant("a4", "Reverted.");
	branch.checkpoint("cp2", {
		reasons: [
			fact("Timeout raised to 200 ms, restated.", ["u2"], { supersedes: ["u1"] }),
			fact("Timeout set to 300 ms.", ["u3"], { supersedes: ["u2"] }),
			fact("Timeout back to 100 ms because 300 was too slow.", ["u4"], { supersedes: ["u3"] }),
		],
	});
	return branch;
}

describe("typed history view", () => {
	it("lists one note section across checkpoints, newest first, with every revision marked", () => {
		const branch = revisions();
		const page = listHistory(branch.snapshot(), { kind: "reasons", query: "timeout" });
		const items = page.items as NoteViewItem[];
		expect(items.map((item) => [item.sources[0].entryId, item.supersededBy ?? [], item.inLatestCheckpoint])).toEqual([
			["u4", [], true],
			["u3", ["u4"], true],
			["u2", ["u3"], true],
			["u1", ["u2"], false],
		]);
		// Restated facts appear once, in the latest wording, recorded at their first checkpoint.
		const u2 = items.find((item) => item.sources[0].entryId === "u2")!;
		expect(u2.summary).toBe("Timeout raised to 200 ms, restated.");
		expect(u2.recordedAt).toBe(4);
		expect(u2.supersedes).toEqual(["u1"]);
		expect(u2.sources).toEqual([{ entryId: "u2", role: "user", position: 2 }]);
		expect(u2.excerpt).toEqual({ entryId: "u2", offset: 0, text: "Raise the timeout to 200 ms." });
		expect(items.at(-1)).toMatchObject({ quote: "Set the request timeout to 100 ms.", recordedAt: 4 });
		expect(page.cursor).toBeUndefined();
		// The vendor rule shares entry u1 with the first timeout; the revision of u1 sits in another section.
		const [vendor] = listHistory(branch.snapshot(), { kind: "instructions" }).items as NoteViewItem[];
		expect(vendor.supersededBy).toBeUndefined();
		expect(vendor.sourceRevisedBy).toEqual(["u2"]);
	});

	it("filters by query terms over summaries and sources, including Chinese bigrams", () => {
		const branch = revisions();
		expect(listHistory(branch.snapshot(), { kind: "instructions", query: "vendor" }).items).toHaveLength(1);
		expect(listHistory(branch.snapshot(), { kind: "instructions", query: "deploy" }).items).toHaveLength(0);
		const chinese = new Branch();
		chinese.user("z1", "\u8d85\u65f6\u65f6\u95f4\u6539\u4e3a 200 \u6beb\u79d2\u3002");
		chinese.assistant("z2", "\u597d\u7684\u3002");
		chinese.checkpoint("zc", { reasons: [fact("\u8d85\u65f6 200 \u6beb\u79d2", ["z1"])] });
		expect(viewTerms("\u8d85\u65f6\u8bbe\u7f6e")).toContain("\u8d85\u65f6");
		expect(
			listHistory(chinese.snapshot(), { kind: "reasons", query: "\u8d85\u65f6\u8bbe\u7f6e" }).items,
		).toHaveLength(1);
	});

	it("lists edits with their outcome and errors from tool results and shell commands", () => {
		const branch = new Branch();
		branch.user("u1", "Write the report.");
		branch.assistant("a1", "Writing.", [
			{ id: "t1", name: "write", path: "out/report.md" },
			{ id: "t2", name: "edit", path: "src/report.js" },
			{ id: "t3", name: "read", path: "src/other.js" },
		]);
		branch.result("r1", "t1", "write", "Wrote out/report.md");
		branch.result("r2", "t2", "edit", "Edit failed: text not found", true);
		branch.assistant("a2", "Retrying.", [{ id: "t4", name: "edit", path: "src/report.js" }]);
		branch.bash("b1", "npm test", "1 failing", 1);
		branch.bash("b2", "ls", "ok", 0);
		branch.bash("b3", "sleep", "", undefined);
		const edits = listHistory(branch.snapshot(), { kind: "edits" }).items as EditViewItem[];
		expect(edits.map((item) => [item.entryId, item.tool, item.path, item.outcome])).toEqual([
			["a2", "edit", "src/report.js", "no-result"],
			["a1", "write", "out/report.md", "ok"],
			["a1", "edit", "src/report.js", "error"],
		]);
		expect(listHistory(branch.snapshot(), { kind: "edits", query: "out/report.md" }).items).toHaveLength(1);
		const errors = listHistory(branch.snapshot(), { kind: "errors" }).items as ErrorViewItem[];
		expect(errors.map((item) => [item.entryId, item.role, item.tool, item.exitCode])).toEqual([
			["b1", "bashExecution", undefined, 1],
			["r2", "toolResult", "edit", undefined],
		]);
		expect(errors[1].excerpt.text).toBe("Edit failed: text not found");
		// No checkpoint: note sections are empty and say why, without implying the history lacks the item.
		const empty = listHistory(branch.snapshot(), { kind: "reasons" });
		expect(empty.items).toEqual([]);
		expect(empty.message).toContain("search before concluding");
	});

	it("never lists a source outside the snapshot's branch", () => {
		// Two branches share u0; the left one holds a checkpoint citing an entry only it has.
		const left = new Branch();
		left.user("u0", "Shared start.");
		left.user("left", "Left branch: use port 4100.");
		left.assistant("a", "Noted.");
		left.checkpoint("cp", { reasons: [fact("Port 4100.", ["left"]), fact("Started.", ["u0"])] });
		expect(listHistory(left.snapshot(), { kind: "reasons" }).items).toHaveLength(2);
		const right = new Branch();
		right.user("u0", "Shared start.");
		right.user("right", "Right branch: use port 4317.");
		expect(listHistory(right.snapshot(), { kind: "reasons" }).items).toEqual([]);
		// A fact whose sources leave the snapshot keeps only the sources that remain, or is not listed.
		const snapshot = left.snapshot();
		const pruned = { ...snapshot, entries: snapshot.entries.filter((entry) => entry.id !== "left") };
		expect((listHistory(pruned, { kind: "reasons" }).items as NoteViewItem[]).map((item) => item.summary)).toEqual([
			"Started.",
		]);
	});

	it("keeps distinct facts on one source apart and follows each through a restatement", () => {
		const branch = new Branch();
		branch.user("u1", "Use port 4317. Leave vendor/ unchanged.");
		branch.assistant("a1", "Noted.");
		branch.checkpoint("cp1", { instructions: [fact("Port 4317.", ["u1"]), fact("Vendor unchanged.", ["u1"])] });
		branch.user("u2", "Continue.");
		branch.assistant("a2", "Continuing.");
		branch.checkpoint("cp2", {
			instructions: [fact("Port is 4317.", ["u1"]), fact("Do not modify vendor/.", ["u1"])],
		});
		const items = listHistory(branch.snapshot(), { kind: "instructions" }).items as NoteViewItem[];
		expect(items.map((item) => [item.summary, item.recordedAt, item.inLatestCheckpoint])).toEqual([
			["Port is 4317.", 2, true],
			["Do not modify vendor/.", 2, true],
		]);
	});

	it("marks a revision only on the facts it replaces when their source supports others too", () => {
		const branch = new Branch();
		branch.user("a", "Do not modify vendor/. Set the timeout to 100 ms.");
		branch.assistant("a1", "Noted.");
		branch.checkpoint("cp1", {
			instructions: [fact("Do not modify vendor/.", ["a"], { quote: "Do not modify vendor/." })],
			reasons: [fact("Timeout is 100 ms.", ["a"])],
		});
		branch.user("b", "Raise the timeout to 200 ms; the other rules stand.");
		branch.assistant("b1", "Raised.");
		branch.checkpoint("cp2", {
			instructions: [fact("Do not modify vendor/.", ["a"], { quote: "Do not modify vendor/." })],
			reasons: [fact("Timeout raised to 200 ms.", ["b"], { supersedes: ["a"] })],
		});
		const instructions = listHistory(branch.snapshot(), { kind: "instructions" }).items as NoteViewItem[];
		// The revision names entry a, which also carries the vendor rule; it does not replace that rule.
		expect(instructions).toHaveLength(1);
		expect(instructions[0].supersededBy).toBeUndefined();
		expect(instructions[0].sourceRevisedBy).toEqual(["b"]);
		expect(instructions[0].inLatestCheckpoint).toBe(true);
		const reasons = listHistory(branch.snapshot(), { kind: "reasons" }).items as NoteViewItem[];
		expect(reasons.map((item) => [item.summary, item.supersededBy ?? [], item.sourceRevisedBy ?? []])).toEqual([
			["Timeout raised to 200 ms.", [], []],
			["Timeout is 100 ms.", ["b"], []],
		]);
	});

	it("does not guess which of several facts on one source a single revision replaces", () => {
		const branch = new Branch();
		branch.user("a", "Set the timeout to 100 ms and the retry count to 3.");
		branch.assistant("a1", "Noted.");
		branch.checkpoint("cp1", { state: [fact("Timeout 100 ms.", ["a"]), fact("Retries 3.", ["a"])] });
		branch.user("b", "Raise the timeout to 200 ms.");
		branch.assistant("b1", "Raised.");
		branch.checkpoint("cp2", { state: [fact("Timeout 200 ms.", ["b"], { supersedes: ["a"] })] });
		const ambiguous = listHistory(branch.snapshot(), { kind: "state" }).items as NoteViewItem[];
		expect(ambiguous.map((item) => [item.summary, item.supersededBy ?? [], item.sourceRevisedBy ?? []])).toEqual([
			["Timeout 200 ms.", [], []],
			["Timeout 100 ms.", [], ["b"]],
			["Retries 3.", [], ["b"]],
		]);
		// Two revisions that name the entry account for both facts on it.
		branch.user("c", "Set retries to 5.");
		branch.assistant("c1", "Set.");
		branch.checkpoint("cp3", {
			state: [
				fact("Timeout 200 ms.", ["b"], { supersedes: ["a"] }),
				fact("Retries 5.", ["c"], { supersedes: ["a"] }),
			],
		});
		const counted = listHistory(branch.snapshot(), { kind: "state" }).items as NoteViewItem[];
		expect(counted.map((item) => [item.summary, item.supersededBy ?? [], item.sourceRevisedBy ?? []])).toEqual([
			["Retries 5.", [], []],
			["Timeout 200 ms.", [], []],
			["Timeout 100 ms.", ["b", "c"], []],
			["Retries 3.", ["b", "c"], []],
		]);
	});

	it("pages under the token bound and continues a cursor after the branch grows", () => {
		const branch = new Branch();
		branch.user("u0", "Start.");
		const facts: NoteFact[] = [];
		for (let index = 1; index <= 40; index++) {
			branch.user(`u${index}`, `Decision ${index}: ${"detail ".repeat(60)}`);
			facts.push(fact(`Decision ${index}.`, [`u${index}`]));
		}
		branch.assistant("a", "Noted.");
		branch.checkpoint("cp", { reasons: facts });
		const first = listHistory(branch.snapshot(), { kind: "reasons" }, 1000);
		expect(first.items.length).toBeGreaterThan(0);
		expect(first.items.length).toBeLessThan(40);
		expect(first.cursor).toBeDefined();
		const firstIds = first.items.map((item) => (item as NoteViewItem).sources[0].entryId);
		expect(firstIds[0]).toBe("u40");
		// The tool call and its result grow the branch before the next page is requested.
		branch.user("later", "A later message.");
		const second = listHistory(branch.snapshot(), { kind: "reasons", cursor: first.cursor }, 1000);
		const secondIds = second.items.map((item) => (item as NoteViewItem).sources[0].entryId);
		expect(secondIds[0]).toBe(`u${40 - firstIds.length}`);
		expect(second.leafId).toBe("cp");
		expect(() => listHistory(branch.snapshot(), { kind: "files", cursor: first.cursor })).toThrow(
			"HISTORY_CURSOR_INVALID",
		);
		expect(() => listHistory(branch.snapshot(), { kind: "reasons", query: "x", cursor: first.cursor })).toThrow(
			"HISTORY_CURSOR_INVALID",
		);
		expect(() => listHistory(branch.snapshot(), { kind: "reasons", cursor: "not-a-cursor" })).toThrow(
			"HISTORY_CURSOR_INVALID",
		);
		const other = new Branch();
		other.user("u0", "Different start.");
		expect(() => listHistory(other.snapshot(), { kind: "reasons", cursor: first.cursor })).toThrow(
			"HISTORY_CURSOR_INVALID",
		);
		expect(() => listHistory(branch.snapshot(), {})).toThrow("HISTORY_KIND_REQUIRED");
	});

	it("reports the cost of one call on the largest session the preview accepts", () => {
		const branch = new Branch();
		const facts: NoteFact[] = [];
		for (let index = 0; index < 125_000; index++) {
			branch.user(`u${index}`, `Message ${index} about component ${index % 97}.`);
			branch.assistant(`a${index}`, "Noted.");
			if (index % 500 === 0) facts.push(fact(`Decision ${index}.`, [`u${index}`]));
		}
		branch.checkpoint("cp", { reasons: facts });
		const snapshot = branch.snapshot();
		const started = performance.now();
		const page = listHistory(snapshot, { kind: "reasons", query: "component 42" });
		const elapsed = performance.now() - started;
		expect(snapshot.entries.length).toBe(250_001);
		expect(page.items.length).toBeGreaterThan(0);
		// Reported, not asserted: machines differ. The plan's threshold for persisting the view is 200 ms.
		console.log(`history view: ${snapshot.entries.length} entries, one list call ${elapsed.toFixed(1)} ms`);
	});
});

/** Every page an unchanged full `read` returns for the entry, as the tool's text. */
function fullRead(snapshot: HistorySnapshot, entryId: string): string[] {
	const pages: string[] = [];
	let cursor: string | undefined;
	do {
		const page = queryHistory(snapshot, { operation: "read", entryId, ...(cursor ? { cursor } : {}) });
		pages.push(JSON.stringify(page));
		cursor = page.cursor;
	} while (cursor);
	return pages;
}

const fullCost = (snapshot: HistorySnapshot, entryId: string) =>
	fullRead(snapshot, entryId).reduce((sum, page) => sum + textTokens(page), 0);

/** A failing suite whose long log spans several read pages, a short error, and a checkpoint over both. */
function failures(): Branch {
	const branch = new Branch();
	branch.user("u1", "Run the integration suite and fix what fails.");
	branch.assistant("a1", "Running the suite.", [{ id: "t1", name: "bash" }]);
	const log = Array.from({ length: 1200 }, (_, line) => `line ${line}: assertion failed in retry_budget`).join("\n");
	branch.result("r1", "t1", "bash", log, true);
	branch.assistant("a2", "Editing the limit.", [{ id: "t2", name: "edit", path: "src/limits.ts" }]);
	branch.result("r2", "t2", "edit", "Edit failed: text not found", true);
	branch.user("z1", `重试预算日志 ${"失败".repeat(3000)}`);
	branch.assistant("a3", "Noted.");
	branch.checkpoint("cp", { state: [fact("The suite fails on the retry budget.", ["u1", "r1"])] });
	branch.user("u2", "Try the edit again.");
	branch.assistant("a4", "Retrying the edit.", [{ id: "t3", name: "edit", path: "src/limits.ts" }]);
	branch.result("r3", "t3", "edit", "Edit failed: retry_budget is read-only", true);
	return branch;
}

describe("retrieval cost and context marks", () => {
	it("states readTokens as the estimate of every page a full read returns", () => {
		const snapshot = failures().snapshot();
		const errors = listHistory(snapshot, { kind: "errors" }).items as ErrorViewItem[];
		expect(errors.map((item) => item.entryId)).toEqual(["r3", "r2", "r1"]);
		for (const item of errors) expect(item.readTokens).toBe(fullCost(snapshot, item.entryId));
		// The long log spans pages; its cost is its escaped bytes plus a bounded overhead per page.
		const log = sourceText(snapshot.entries[2]);
		const pages = fullRead(snapshot, "r1").length;
		expect(pages).toBeGreaterThan(3);
		const long = errors.find((item) => item.entryId === "r1")!;
		expect(long.readTokens).toBeGreaterThanOrEqual(textTokens(JSON.stringify(log)));
		expect(long.readTokens - textTokens(JSON.stringify(log))).toBeLessThanOrEqual(pages * 200);
		// Multi-byte text pages by bytes, and its cost follows.
		const chinese = snapshot.entries.findIndex((entry) => entry.id === "z1");
		expect(fullRead(snapshot, "z1").length).toBeGreaterThan(1);
		const hits = priceSearch(queryHistory(snapshot, { operation: "search", query: "重试" }), snapshot);
		expect(hits.entries.find((hit) => hit.entryId === "z1")).toMatchObject({
			position: chinese,
			readTokens: fullCost(snapshot, "z1"),
		});
		// Search hits carry the same price as list items, and a fact sums its sources.
		const search = priceSearch(queryHistory(snapshot, { operation: "search", query: "retry_budget" }), snapshot);
		expect(search.entries.length).toBeGreaterThan(1);
		for (const hit of search.entries) expect(hit.readTokens).toBe(fullCost(snapshot, hit.entryId));
		const [state] = listHistory(snapshot, { kind: "state" }).items as NoteViewItem[];
		expect(state.readTokens).toBe(fullCost(snapshot, "u1") + fullCost(snapshot, "r1"));
		const edits = listHistory(snapshot, { kind: "edits" }).items as EditViewItem[];
		for (const item of edits) expect(item.readTokens).toBe(fullCost(snapshot, item.entryId));
	});

	it("bounds a low-detail read and states the cost of the full one", () => {
		const snapshot = failures().snapshot();
		const low = readLowDetail(snapshot, { entryId: "r1" });
		const [hit] = low.entries;
		const log = sourceText(snapshot.entries[2]);
		expect(low.detail).toBe("low");
		expect(log.startsWith(hit.text)).toBe(true);
		expect(textTokens(JSON.stringify(hit.text))).toBeLessThanOrEqual(LOW_DETAIL_TOKENS);
		expect(textTokens(JSON.stringify(log.slice(0, hit.text.length + 1)))).toBeGreaterThan(LOW_DETAIL_TOKENS);
		expect(hit).toMatchObject({ entryId: "r1", role: "toolResult", position: 2, offset: 0, complete: false });
		expect(hit.readTokens).toBe(fullCost(snapshot, "r1"));
		expect(low.message).toContain(`about ${hit.readTokens} tokens`);
		expect(low).not.toHaveProperty("cursor");
		// A short entry comes back whole, with nothing more to read.
		const short = readLowDetail(snapshot, { entryId: "r2" });
		expect(short.entries[0]).toMatchObject({ text: "Edit failed: text not found", complete: true });
		expect(short.message).toBeUndefined();
		// The bound never splits a character.
		const emoji = new Branch();
		emoji.user("e1", "\u{1F600}".repeat(400));
		const cut = readLowDetail(emoji.snapshot(), { entryId: "e1" }).entries[0].text;
		expect(cut.length).toBeGreaterThan(0);
		expect(cut).toBe("\u{1F600}".repeat(cut.length / 2));
		// Refused as read refuses, and without a continuation.
		expect(() => readLowDetail(snapshot, {})).toThrow("HISTORY_ENTRY_REQUIRED");
		expect(() => readLowDetail(snapshot, { entryId: "missing" })).toThrow("HISTORY_SCOPE_DENIED");
		expect(() => readLowDetail(snapshot, { entryId: "cp" })).toThrow("HISTORY_SCOPE_DENIED");
		expect(() => readLowDetail(snapshot, { entryId: "r1", cursor: "x" })).toThrow("HISTORY_QUERY_INVALID");
		// Full stays the default: low is offered only on request.
		expect(JSON.stringify(previewHistorySchema.properties.detail)).toContain('"low"');
		expect(previewHistorySchema.required ?? []).not.toContain("detail");
	});

	it("marks entries in the active projection and leaves compacted and reduced entries unmarked", () => {
		const branch = failures();
		const snapshot = branch.snapshot();
		const projection = buildSessionProjection(branch.entries);
		const inContext = inContextEntries(projection);
		const marks = (items: readonly { entryId: string; inContext?: true }[]) =>
			items.map((item) => [item.entryId, item.inContext ?? false]);
		// The checkpoint released everything before it; what follows is in context.
		expect(marks(listHistory(snapshot, { kind: "errors" }, 4000, inContext).items as ErrorViewItem[])).toEqual([
			["r3", true],
			["r2", false],
			["r1", false],
		]);
		expect(marks(listHistory(snapshot, { kind: "edits" }, 4000, inContext).items as EditViewItem[])).toEqual([
			["a4", true],
			["a2", false],
		]);
		const search = priceSearch(
			queryHistory(snapshot, { operation: "search", query: "retry_budget" }),
			snapshot,
			inContext,
		);
		expect(Object.fromEntries(marks(search.entries))).toEqual({ r3: true, r1: false });
		// A fact is marked only when every source is in context in full.
		const [state] = listHistory(snapshot, { kind: "state" }, 4000, inContext).items as NoteViewItem[];
		expect(state.inContext).toBeUndefined();
		expect(listHistory(snapshot, { kind: "state" }, 4000, () => true).items[0].inContext).toBe(true);
		expect(listHistory(snapshot, { kind: "state" }, 4000, (id) => id === "u1").items[0].inContext).toBeUndefined();
		// A reduced entry shows only its one line in context, so it is not marked; its neighbours still are.
		const reduced = inContextEntries(projection, (id) => id === "r3");
		expect(marks(listHistory(snapshot, { kind: "errors" }, 4000, reduced).items as ErrorViewItem[])).toEqual([
			["r3", false],
			["r2", false],
			["r1", false],
		]);
		expect(marks(listHistory(snapshot, { kind: "edits" }, 4000, reduced).items as EditViewItem[])[0]).toEqual([
			"a4",
			true,
		]);
		// Without a predicate nothing is claimed to be in context.
		expect(listHistory(snapshot, { kind: "errors" }).items.some((item) => item.inContext)).toBe(false);
	});
});

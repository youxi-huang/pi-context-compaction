import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { HistorySnapshot } from "../src/extensions/context-memory/history.ts";
import { CONTEXT_MEMORY_KIND, CONTEXT_MEMORY_VERSION } from "../src/extensions/context-memory/identity.ts";
import { hashEntries, type MemoryNote, type NoteFact } from "../src/extensions/context-memory/notes.ts";
import {
	type EditViewItem,
	type ErrorViewItem,
	listHistory,
	type NoteViewItem,
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

// Cloned from the queryHistory blocks of packages/coding-agent/test/context-memory.test.ts
// ("read cursors survive appended tool messages but cannot cross to a sibling branch" and
// "history search ranks conversation turns above tool output and newer entries first"),
// retargeted at the core copy. The resident tests keep running against the resident copy
// untouched; this file imports nothing from Pi. Snapshots are built directly from invented
// records because `freezeHistory` reads the host's session manager and stays host-side.
import { describe, expect, it } from "vitest";
import { excerptStart, type HistorySnapshot, queryHistory } from "../src/history.ts";
import { hashEntries } from "../src/identity.ts";
import type { SessionRecord } from "../src/records.ts";

const timestamp = "2026-01-01T00:00:00.000Z";
const sourceTextOf = (record: SessionRecord) =>
	record.type === "message" && typeof record.message.content === "string" ? record.message.content : "";

function user(id: string, parentId: string | null, content: string): SessionRecord {
	return { type: "message", id, parentId, timestamp, message: { role: "user", content } };
}

function reply(id: string, parentId: string, text: string): SessionRecord {
	return {
		type: "message",
		id,
		parentId,
		timestamp,
		message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" },
	};
}

function snapshot(entries: readonly SessionRecord[]): HistorySnapshot {
	return {
		sessionId: "synthetic-session",
		leafId: entries.length ? entries[entries.length - 1].id : null,
		scopeHash: hashEntries(entries),
		entries,
	};
}

describe("compaction core: branch-scoped history retrieval", () => {
	it("read cursors survive appended tool messages but cannot cross to a sibling branch", () => {
		const first = user("entry-1", null, "source-".repeat(6000));
		const initial = snapshot([first]);
		const page = queryHistory(initial, { operation: "read", entryId: "entry-1" }, 800);
		expect(page.cursor).toBeTruthy();
		expect(() => queryHistory(initial, { operation: "read", cursor: page.cursor }, 800)).toThrow(
			"repeat the original operation, query, entryId and grantId",
		);
		const appended = snapshot([first, reply("entry-2", "entry-1", "a tool interaction appended while reading")]);
		const next = queryHistory(appended, { operation: "read", entryId: "entry-1", cursor: page.cursor }, 800);
		expect(next.entries[0].offset).toBe(page.entries[0].text.length);
		const sibling = snapshot([user("entry-3", null, "sibling secret")]);
		expect(() => queryHistory(sibling, { operation: "read", entryId: "entry-1", cursor: next.cursor }, 800)).toThrow(
			"HISTORY_CURSOR_INVALID",
		);
		expect(queryHistory(appended, { operation: "search", query: "sibling secret" }).entries).toHaveLength(0);
	});

	it("history search ranks conversation turns above tool output and newer entries first", () => {
		const early = user("user-early", null, "Let us compact the session later.");
		const call: SessionRecord = {
			type: "message",
			id: "reply-call",
			parentId: "user-early",
			timestamp,
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } }],
				stopReason: "toolUse",
			},
		};
		const dump: SessionRecord = {
			type: "message",
			id: "tool-dump",
			parentId: "reply-call",
			timestamp,
			message: {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				isError: false,
				content: [{ type: "text", text: `compact ${"documentation ".repeat(400)}` }],
			},
		};
		const answer = reply("reply-answer", "tool-dump", "The compact command is manual.");
		const late = user("user-late", "reply-answer", "Run compact now.");
		const frozen = snapshot([early, call, dump, answer, late]);
		const page = queryHistory(frozen, { operation: "search", query: "compact" });
		expect(page.entries.map((entry) => entry.entryId)).toEqual([
			"user-late",
			"user-early",
			"reply-answer",
			"tool-dump",
		]);
		expect(page.entries.map((entry) => entry.position)).toEqual([4, 0, 3, 2]);
		// More matched terms outrank role: the tool result is the only entry that contains both words.
		expect(queryHistory(frozen, { operation: "search", query: "compact documentation" }).entries[0].entryId).toBe(
			"tool-dump",
		);
		// An entry ID in the query still outranks everything else.
		expect(queryHistory(frozen, { operation: "search", query: "compact tool-dump" }).entries[0].entryId).toBe(
			"tool-dump",
		);
	});

	it("centers a search excerpt where the most query terms meet, not where one of them first appears", () => {
		// A pasted lag report: "47" and "lag" appear from the first lines, the peak line comes much later.
		const lines = Array.from(
			{ length: 700 },
			(_, i) =>
				`2026-01-0${(i % 7) + 1}T02:${String(i % 60).padStart(2, "0")}:00Z lag batch=${i} rows=${(i * 37) % 900} latency_ms=${(i * 47) % 400} status=ok`,
		);
		lines[433] = "2026-01-06T02:13:00Z lag peak shard 09 lag_s=47 (highest in window)";
		const report = user("lag-report", null, `$ node scripts/lag-report.js --hours 6\n${lines.join("\n")}`);
		const frozen = snapshot([report]);
		const [hit] = queryHistory(frozen, { operation: "search", query: "lag_s=47 peak" }).entries;
		expect(hit.text).toContain("2026-01-06T02:13:00Z lag peak shard 09 lag_s=47");
		const peak = sourceTextOf(report).indexOf("2026-01-06T02:13:00Z lag peak");
		// The window may open on a "47" in the line before; the excerpt still holds the whole peak line.
		expect(hit.offset).toBeLessThanOrEqual(peak);
		expect(hit.offset).toBeGreaterThanOrEqual(peak - 400 - 120);
		// A single term keeps its first occurrence, 120 characters of lead included.
		const [first] = queryHistory(frozen, { operation: "search", query: "latency_ms" }).entries;
		expect(first.offset).toBe(Math.max(0, sourceTextOf(report).indexOf("latency_ms") - 120));
		// Terms that never meet fall back to the earliest hit.
		expect(excerptStart("alpha ......... beta", ["beta", "alpha"])).toBe(0);
		expect(excerptStart(`${"x".repeat(500)}alpha${"y".repeat(500)}alpha beta`, ["alpha", "beta"])).toBe(1005 - 120);
		expect(excerptStart("nothing here", ["absent"])).toBe(0);
	});

	it("searches past the retrieval tool's own results, which a read by ID still returns", () => {
		const fact = user("fact", null, "The rollback to eu-west takes 18 minutes.");
		const result = (id: string, parentId: string, toolName: string): SessionRecord => ({
			type: "message",
			id,
			parentId,
			timestamp,
			message: {
				role: "toolResult",
				toolCallId: `call-${id}`,
				toolName,
				isError: false,
				content: [{ type: "text", text: '{"entries":[{"text":"The rollback to eu-west takes 18 minutes."}]}' }],
			},
		});
		const frozen = snapshot([
			fact,
			result("earlier-search", "fact", "context_history"),
			result("grep", "earlier-search", "grep"),
		]);
		const page = queryHistory(frozen, { operation: "search", query: "rollback minutes" });
		expect(page.entries.map((entry) => entry.entryId)).toEqual(["fact", "grep"]);
		expect(queryHistory(frozen, { operation: "read", entryId: "earlier-search" }).entries[0].text).toContain(
			"18 minutes",
		);
	});

	it("refuses reads outside the snapshot or without readable text, and enforces the query schema", () => {
		const frozen = snapshot([
			user("user-1", null, "Readable synthetic ruling."),
			{
				type: "compaction",
				id: "checkpoint-1",
				parentId: "user-1",
				timestamp,
				summary: "Stored rendering.",
				firstKeptEntryId: "user-1",
				tokensBefore: 1,
			},
		]);
		expect(() => queryHistory(frozen, { operation: "read", entryId: "missing" })).toThrow("HISTORY_SCOPE_DENIED");
		// The checkpoint record normalizes to empty text: it is never readable through retrieval.
		expect(() => queryHistory(frozen, { operation: "read", entryId: "checkpoint-1" })).toThrow(
			"HISTORY_SCOPE_DENIED",
		);
		expect(() => queryHistory(frozen, { operation: "read" })).toThrow("HISTORY_ENTRY_REQUIRED");
		expect(() => queryHistory(frozen, { operation: "search", query: "!!" })).toThrow("HISTORY_QUERY_REQUIRED");
		expect(() => queryHistory(frozen, { operation: "scan" })).toThrow("HISTORY_QUERY_INVALID");
		expect(queryHistory(frozen, { operation: "search", query: "unmatched" }).message).toContain(
			"No matching evidence",
		);
	});
});

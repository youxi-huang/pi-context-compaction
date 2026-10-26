import { createOpencodeClient, type Part, type UserMessage } from "@opencode-ai/sdk";
import { describe, expect, it } from "vitest";
import { hashCanonicalRecords } from "../../compaction-core/src/canonical.ts";
import { queryHistory } from "../../compaction-core/src/history.ts";
import { sourceText, validateNote } from "../../compaction-core/src/notes.ts";
import { type OpenCodeMessage, openCodeHistorySnapshot } from "../src/codec.ts";
import { readOpenCodeHistory } from "../src/history.ts";
import { SliceHistory } from "../src/index.ts";

const sessionID = "ses_synthetic";
function message(id: string, text = "Synthetic decision: use port 4317."): OpenCodeMessage {
	const info: UserMessage = {
		id,
		sessionID,
		role: "user",
		time: { created: 1 },
		agent: "build",
		model: { providerID: "synthetic", modelID: "scripted" },
	};
	return { info, parts: [{ id: `prt_${id}`, sessionID, messageID: id, type: "text", text }] };
}
const note = (id: string, quote: string) => ({
	instructions: [],
	failedPaths: [],
	reasons: [],
	state: [{ text: "Synthetic fact.", sources: [id], quote }],
	nextSteps: [],
	files: [],
	gaps: [],
});

describe("OpenCode native history codec", () => {
	it("cites durable part IDs, preserves repeated messages, and uses the core quotation/scope checks", () => {
		const snapshot = openCodeHistorySnapshot(sessionID, [message("msg_a"), message("msg_b")]);
		expect(snapshot.entries.map((entry) => entry.id)).toEqual(["msg_a", "prt_msg_a", "msg_b", "prt_msg_b"]);
		expect(validateNote(note("prt_msg_a", "use port 4317"), snapshot.entries)).toBeTruthy();
		expect(() => validateNote(note("msg_a:0", "use port 4317"), snapshot.entries)).toThrow("CONTEXT_NOTE_SCOPE");
		expect(() => validateNote(note("prt_msg_a", "use port 1234"), snapshot.entries)).toThrow("CONTEXT_NOTE_QUOTE");
	});
	it("attributes embedded tool output to the native tool part, with opaque input covered by JCS", () => {
		const input = message("msg_a");
		const part: Part = {
			id: "prt_tool",
			sessionID,
			messageID: input.info.id,
			type: "tool",
			callID: "call_a",
			tool: "read",
			state: {
				status: "completed",
				input: { path: "synthetic.txt" },
				output: "Synthetic tool output",
				title: "read",
				metadata: {},
				time: { start: 1, end: 2, compacted: 3 },
			},
		};
		input.parts.push(part);
		const snapshot = openCodeHistorySnapshot(sessionID, [input]);
		const page = queryHistory(snapshot, { operation: "read", entryId: part.id });
		expect(page.entries[0]).toMatchObject({ entryId: "prt_tool", role: "toolResult", text: "Synthetic tool output" });
		const hash = hashCanonicalRecords(snapshot.entries);
		part.state.input.path = "changed.txt";
		expect(hashCanonicalRecords(openCodeHistorySnapshot(sessionID, [input]).entries)).not.toBe(hash);
	});
	it("keeps ignored text and unknown payloads opaque and labels synthetic text as context", () => {
		const input = message("msg_a");
		input.parts = [
			{
				id: "prt_ignored",
				sessionID,
				messageID: input.info.id,
				type: "text",
				text: "hidden synthetic text",
				ignored: true,
			},
			{
				id: "prt_reasoning",
				sessionID,
				messageID: input.info.id,
				type: "reasoning",
				text: "opaque synthetic content",
				time: { start: 1, end: 2 },
			},
			{
				id: "prt_summary",
				sessionID,
				messageID: input.info.id,
				type: "text",
				text: "synthetic summary",
				synthetic: true,
			},
		];
		const snapshot = openCodeHistorySnapshot(sessionID, [input]);
		expect(snapshot.entries.slice(1, 3).map(sourceText)).toEqual(["", ""]);
		expect(queryHistory(snapshot, { operation: "read", entryId: "prt_summary" }).entries[0].role).toBe("context");
	});
	it("continues a bounded read after append but rejects changed content, scope and query", () => {
		const input = message("msg_a", "synthetic evidence ".repeat(3000));
		const first = openCodeHistorySnapshot(sessionID, [input]);
		const request = { operation: "read", entryId: "prt_msg_a" };
		const page = queryHistory(first, request, 512);
		expect(page.cursor).toBeTruthy();
		const appended = openCodeHistorySnapshot(sessionID, [input, message("msg_b")]);
		const next = queryHistory(appended, { ...request, cursor: page.cursor }, 512);
		expect(next.entries[0].offset).toBe(page.entries[0].text.length);
		expect(JSON.stringify(next).length).toBeLessThan(5000);
		const edited = openCodeHistorySnapshot(sessionID, [message("msg_a", "changed"), message("msg_b")]);
		expect(() => queryHistory(edited, { ...request, cursor: page.cursor })).toThrow("HISTORY_CURSOR_INVALID");
		expect(() => queryHistory({ ...appended, sessionId: "ses_other" }, { ...request, cursor: page.cursor })).toThrow(
			"HISTORY_CURSOR_INVALID",
		);
		expect(() => queryHistory(appended, { ...request, entryId: "prt_msg_b", cursor: page.cursor })).toThrow(
			"HISTORY_CURSOR_INVALID",
		);
	});
	it("rejects cross-session parts and colliding native IDs instead of choosing a winner", () => {
		const input = message("msg_a");
		expect(() => openCodeHistorySnapshot("ses_other", [input])).toThrow("HISTORY_SCOPE_DENIED");
		input.parts[0].sessionID = "ses_other";
		expect(() => openCodeHistorySnapshot(sessionID, [input])).toThrow("HISTORY_SCOPE_DENIED");
		expect(() => openCodeHistorySnapshot(sessionID, [message("msg_a"), message("msg_a")])).toThrow(
			"HISTORY_SOURCE_INVALID",
		);
	});
	it("normalizes native object key order for cursor stability", () => {
		const first = message("msg_a");
		const reversed = {
			parts: first.parts,
			info: Object.fromEntries(Object.entries(first.info).reverse()) as UserMessage,
		};
		expect(openCodeHistorySnapshot(sessionID, [reversed]).scopeHash).toBe(
			openCodeHistorySnapshot(sessionID, [first]).scopeHash,
		);
	});
});

describe("OpenCode supplied SDK binding", () => {
	it("registers only retrieval and respects a permission denial before reading", async () => {
		let reads = 0;
		const client = createOpencodeClient({
			baseUrl: "http://synthetic.invalid",
			fetch: async () => {
				reads++;
				return Response.json([]);
			},
		});
		const hooks = await SliceHistory({ client });
		expect(Object.keys(hooks)).toEqual(["tool"]);
		expect(Object.keys(hooks.tool ?? {})).toEqual(["context_history"]);
		const history = hooks.tool?.context_history;
		if (!history) throw new Error("missing history tool");
		await expect(
			history.execute(
				{ operation: "search", query: "synthetic" },
				{
					sessionID,
					messageID: "msg_active",
					directory: "synthetic-project",
					abort: new AbortController().signal,
					ask: async (request) => {
						expect(request.permission).toBe("context_history");
						throw new Error("synthetic denied");
					},
				},
			),
		).rejects.toThrow("synthetic denied");
		expect(reads).toBe(0);
	});
	it("requests complete current-session storage and excludes the changing calling message", async () => {
		const paths: string[] = [];
		const client = createOpencodeClient({
			baseUrl: "http://synthetic.invalid",
			fetch: async (input) => {
				const request = input as Request;
				paths.push(request.url);
				const url = new URL(request.url);
				expect(request.method).toBe("GET");
				expect(url.searchParams.get("directory")).toBe("synthetic-project");
				expect(url.searchParams.has("limit")).toBe(false);
				return Response.json(
					url.pathname.endsWith("/message")
						? [message("msg_a"), message("msg_active", "in flight")]
						: { id: sessionID },
				);
			},
		});
		const page = await readOpenCodeHistory(
			client,
			sessionID,
			"synthetic-project",
			"msg_active",
			{ operation: "search", query: "4317" },
			new AbortController().signal,
		);
		expect(page.entries.map((entry) => entry.entryId)).toEqual(["prt_msg_a"]);
		expect(paths.map((path) => new URL(path).pathname)).toEqual([
			`/session/${sessionID}`,
			`/session/${sessionID}/message`,
		]);
	});
	it("rejects forks, missing boundaries, and pre-aborted calls without hidden fallback", async () => {
		let reads = 0;
		const client = createOpencodeClient({
			baseUrl: "http://synthetic.invalid",
			fetch: async () => {
				reads++;
				return Response.json({ id: sessionID, parentID: "ses_parent" });
			},
		});
		const run = (signal: AbortSignal) =>
			readOpenCodeHistory(
				client,
				sessionID,
				"synthetic-project",
				"msg_active",
				{ operation: "search", query: "4317" },
				signal,
			);
		await expect(run(new AbortController().signal)).rejects.toThrow("HISTORY_SCOPE_DENIED");
		expect(reads).toBe(1);
		await expect(run(AbortSignal.abort(new Error("synthetic cancellation")))).rejects.toThrow(
			"synthetic cancellation",
		);
		expect(reads).toBe(1);
		const missing = createOpencodeClient({
			baseUrl: "http://synthetic.invalid",
			fetch: async (input) =>
				Response.json(
					new URL((input as Request).url).pathname.endsWith("/message") ? [message("msg_a")] : { id: sessionID },
				),
		});
		await expect(
			readOpenCodeHistory(missing, sessionID, "synthetic-project", "msg_active", {}, new AbortController().signal),
		).rejects.toThrow("calling message is missing");
	});
});

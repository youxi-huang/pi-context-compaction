import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Message,
	type Model,
} from "@earendil-works/pi-ai";
import {
	buildSessionProjection,
	type CompactionEntry,
	type ExtensionContext,
	type SessionBeforeCompactEvent,
	type SessionEntry,
	type SessionHeader,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MEMORY_CONFIG } from "../src/extensions/context-memory/config.ts";
import { freezeHistory, queryHistory } from "../src/extensions/context-memory/history.ts";
import type { MemoryNote } from "../src/extensions/context-memory/notes.ts";
import { CallJournal } from "../src/extensions/context-memory/preview/call-journal.ts";
import type { PreviewCompaction, PreviewSession } from "../src/extensions/context-memory/preview/contracts.ts";
import { PreviewMemoryController, preparationStart } from "../src/extensions/context-memory/preview/controller.ts";
import { PreviewFailureStore } from "../src/extensions/context-memory/preview/failure-store.ts";
import { PreviewPreparation } from "../src/extensions/context-memory/preview/preparation.ts";

const model: Model<Api> = {
	id: "pressure-fixture",
	name: "Synthetic",
	provider: "synthetic",
	api: "openai-completions",
	baseUrl: "http://127.0.0.1:9",
	reasoning: false,
	input: ["text"],
	contextWindow: 200_000,
	maxTokens: 32_000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const reply = (text = "Synthetic turn complete."): AssistantMessage => ({
	role: "assistant",
	api: model.api,
	provider: model.provider,
	model: model.id,
	content: [{ type: "text", text }],
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
});

/** Linear synthetic append log; official-host acceptance is run separately from this unit fixture. */
class PressureSession implements PreviewSession {
	readonly file: string;
	readonly header: SessionHeader;
	entries: SessionEntry[] = [];
	constructor(root: string, reopen = false) {
		this.file = join(root, "session.jsonl");
		this.header = {
			type: "session",
			version: 3,
			id: "synthetic-pressure",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: root,
		};
		if (reopen)
			this.entries = readFileSync(this.file, "utf8")
				.trim()
				.split("\n")
				.slice(1)
				.map((line) => JSON.parse(line) as SessionEntry);
		else writeFileSync(this.file, `${JSON.stringify(this.header)}\n`);
	}
	getCwd() {
		return this.header.cwd;
	}
	getSessionDir() {
		return this.header.cwd;
	}
	getSessionId() {
		return this.header.id;
	}
	getSessionFile() {
		return this.file;
	}
	getLeafId() {
		return this.entries.at(-1)?.id ?? null;
	}
	getLeafEntry() {
		return this.entries.at(-1);
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
	getBranch(fromId?: string) {
		return fromId === undefined
			? [...this.entries]
			: this.entries.slice(0, this.entries.findIndex((entry) => entry.id === fromId) + 1);
	}
	buildContextEntries() {
		return this.getBranch();
	}
	buildSessionProjection() {
		return buildSessionProjection(this.getBranch());
	}
	appendMessage(message: Message) {
		const entry: SessionEntry = {
			id: `source-${this.entries.length}`,
			parentId: this.getLeafId(),
			timestamp: this.header.timestamp,
			type: "message",
			message,
		};
		this.entries.push(entry);
		appendFileSync(this.file, `${JSON.stringify(entry)}\n`);
		return entry.id;
	}
	appendCompaction(value: PreviewCompaction): CompactionEntry {
		const entry: CompactionEntry = {
			...value,
			fromHook: true,
			id: `checkpoint-${this.entries.length}`,
			parentId: this.getLeafId(),
			timestamp: this.header.timestamp,
			type: "compaction",
		};
		this.entries.push(entry);
		appendFileSync(this.file, `${JSON.stringify(entry)}\n`);
		return entry;
	}
}

describe("Pi preparation at an explicitly lowered compaction budget", () => {
	let root: string;
	let session: PressureSession;
	let preparation: PreviewPreparation;
	let controller: PreviewMemoryController;
	let store: PreviewFailureStore;
	let ctx: ExtensionContext;
	let tokens: number;
	let calls: number;
	let malformed: boolean;
	let output: MemoryNote;
	let firstSource: string;
	const config = { ...DEFAULT_MEMORY_CONFIG, compactAt: 150_000, keepRecentTokens: 15_000, noteRepair: false };
	function appendCycle(): string {
		const source = session.appendMessage({
			role: "user",
			content: `Synthetic evidence port 4317. ${"old ".repeat(9000)}`,
			timestamp: 1,
		});
		session.appendMessage(reply());
		const tail = session.appendMessage({
			role: "user",
			content: `Current instruction. ${"recent ".repeat(9000)}`,
			timestamp: 1,
		});
		session.appendMessage(reply());
		output.state.push({ text: "Synthetic port is 4317.", sources: [source] });
		return tail;
	}
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "slice-pressure-"));
		session = new PressureSession(root);
		output = { instructions: [], state: [], reasons: [], failedPaths: [], nextSteps: [], files: [], gaps: [] };
		appendCycle();
		firstSource = output.state[0].sources[0];
		calls = 0;
		malformed = false;
		tokens = 131_249;
		const journal = new CallJournal(join(root, "agent"));
		preparation = new PreviewPreparation({ enabled: true, journal });
		store = new PreviewFailureStore(join(root, "agent"));
		controller = new PreviewMemoryController({ config, failureStore: store, preparation, journal });
		ctx = {
			sessionManager: session,
			model,
			thinkingLevel: "off",
			hasUI: false,
			getSystemPrompt: () => "Synthetic system.",
			hasPendingMessages: () => false,
			getContextUsage: () => ({ tokens, contextWindow: ctx.model?.contextWindow, percent: null }),
			abort: vi.fn(),
			modelRegistry: {
				hasConfiguredAuth: () => true,
				streamSimple: () => {
					calls++;
					const message = reply(malformed ? "invalid synthetic summary" : JSON.stringify(output));
					const stream = createAssistantMessageEventStream();
					stream.push({ type: "done", reason: "stop", message });
					stream.end(message);
					return stream;
				},
			},
		} as unknown as ExtensionContext;
		controller.sessionStart(ctx);
	});
	afterEach(async () => {
		preparation?.dispose();
		await preparation?.waitForIdle();
		rmSync(root, { recursive: true, force: true });
	});
	async function prepare() {
		controller.prepare(ctx);
		await preparation.waitForIdle();
	}
	function event(): SessionBeforeCompactEvent {
		return {
			type: "session_before_compact",
			reason: "threshold",
			willRetry: false,
			signal: new AbortController().signal,
			preparation: { tokensBefore: 150_001 },
		} as SessionBeforeCompactEvent;
	}
	it("starts at 131,250 instead of waiting until after the 150k trigger", async () => {
		await prepare();
		expect(calls).toBe(0);
		tokens++;
		await prepare();
		expect(calls).toBe(1);
		expect(controller.status(ctx).preparation?.state).toBe("ready");
	});
	it("keeps one preparation per interval through three commits and recovers originals after reopen", async () => {
		tokens = 131_250;
		for (let cycle = 0; cycle < 3; cycle++) {
			if (cycle) appendCycle();
			await prepare();
			tokens++;
			await prepare();
			expect(calls).toBe(cycle + 1);
			const result = await controller.compact(event(), ctx);
			expect(result.details?.preparation?.path).toBe("complete");
			const entry = session.appendCompaction(result);
			controller.committed(
				{
					type: "session_compact",
					compactionEntry: entry,
					fromExtension: true,
					reason: "threshold",
					willRetry: false,
				},
				ctx,
			);
			expect(() => controller.assertReady(ctx)).not.toThrow();
			expect(
				session
					.buildSessionProjection()
					.messages.some((message) => JSON.stringify(message).includes("Current instruction.")),
			).toBe(true);
			expect(calls).toBe(cycle + 1);
		}
		const file = session.getSessionFile();
		if (!file) throw new Error("Missing synthetic session file");
		session = new PressureSession(root, true);
		const page = queryHistory(freezeHistory(session), { operation: "read", entryId: firstSource });
		expect(page.entries[0].text).toContain("Synthetic evidence port 4317.");
		expect(new PreviewFailureStore(join(root, "agent")).inspect(session).state).toBe("ready");
		expect(ctx.abort).not.toHaveBeenCalled();
	});
	it("a failed preparation is not repeated; synchronous summary failure still blocks", async () => {
		malformed = true;
		tokens = 131_250;
		await prepare();
		await prepare();
		expect(calls).toBe(1);
		expect(store.inspect(session).state).toBe("ready");
		await expect(controller.compact(event(), ctx)).rejects.toThrow("CONTEXT_");
		expect(store.inspect(session).state).toBe("blocked");
		expect(() => controller.assertReady(ctx)).toThrow("CONTEXT_");
	});
	it("recalculates the preparation band on a smaller model and does not weaken the payload guard", async () => {
		ctx = { ...ctx, model: { ...model, contextWindow: 128_000 } };
		tokens = 83_999;
		await prepare();
		expect(calls).toBe(0);
		tokens = 84_000;
		await prepare();
		expect(calls).toBe(1);
		controller.beforeRequest({ toolOutput: "burst ".repeat(100_000) }, ctx);
		expect(ctx.abort).toHaveBeenCalledOnce();
	});
	it("preserves the default band and never delays it for a higher configured threshold", () => {
		expect(preparationStart(200_000)).toBe(160_664);
		expect(preparationStart(200_000, 190_000)).toBe(160_664);
	});
});

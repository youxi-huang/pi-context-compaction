import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	type Usage,
} from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_MEMORY_CONFIG, SESSION_WRITER, textTokens } from "../src/extensions/context-memory/config.ts";
import { type MemoryNote, type NoteFact, noteSchema, validateNote } from "../src/extensions/context-memory/notes.ts";
import {
	diagnoseQuotes,
	normalizeQuote,
	quoteCounts,
	quoteFailureMessage,
	quoteFeedback,
} from "../src/extensions/context-memory/preview/quote-diagnostics.ts";
import { applyQuoteRepair } from "../src/extensions/context-memory/preview/quote-repair.ts";
import { validateWorkNote } from "../src/extensions/context-memory/preview/work-notes.ts";
import {
	type PreviewWriterRegistry,
	quotableOriginals,
	type WriteMemoryOptions,
	type WriterProgress,
	writeMemory,
} from "../src/extensions/context-memory/preview/writer.ts";

const model: Model<Api> = {
	id: "quote-writer",
	name: "Synthetic quotation writer",
	provider: "preview-quote-test",
	api: "openai-completions",
	baseUrl: "https://writer.invalid",
	reasoning: false,
	input: ["text"],
	contextWindow: 128_000,
	maxTokens: 8192,
	cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
};

const usage: Usage = {
	input: 10,
	output: 5,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 15,
	cost: { input: 0.00001, output: 0.00001, cacheRead: 0, cacheWrite: 0, total: 0.00002 },
};

function user(id: string, text: string, parentId: string | null = null): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role: "user", content: text, timestamp: 1 },
	};
}

function assistant(id: string, text: string, parentId: string | null = null): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			timestamp: 1,
			usage,
		},
	};
}

const branch: SessionEntry[] = [
	user("u1", "Keep the service on port 4317.\nDo not touch vendor/."),
	assistant("a1", "Understood: \u201Cdeploy only on Thursday\u201D is my proposal.", "u1"),
	user("u2", "Use \u201Cdeploy only on Thursday\u201D as the ruling.", "a1"),
	user("u3", "The threshold is 15.", "u2"),
];

function note(items: Partial<Record<"state" | "reasons" | "instructions", NoteFact[]>>): MemoryNote {
	return {
		instructions: items.instructions ?? [],
		failedPaths: [],
		reasons: items.reasons ?? [],
		state: items.state ?? [{ text: "The threshold is 15.", sources: ["u3"] }],
		nextSteps: [],
		files: [],
		gaps: [],
	};
}

describe("quotation diagnostics", () => {
	it("classifies text cited to the wrong entry, and lists where it is with roles", () => {
		const diagnosis = diagnoseQuotes(
			note({ instructions: [{ text: "Port rule.", sources: ["u3"], quote: "Keep the service on port 4317." }] }),
			branch,
		);
		expect(diagnosis.unreadable).toBe(false);
		expect(diagnosis.failures).toEqual([
			{
				section: "instructions",
				index: 0,
				quote: "Keep the service on port 4317.",
				cited: ["u3"],
				kind: "elsewhere",
				foundIn: [{ entryId: "u1", role: "user" }],
			},
		]);
	});

	it("lists every entry with the exact text, assistant echoes included", () => {
		const diagnosis = diagnoseQuotes(
			note({ reasons: [{ text: "Thursday rule.", sources: ["u3"], quote: "\u201Cdeploy only on Thursday\u201D" }] }),
			branch,
		);
		expect(diagnosis.failures[0].foundIn).toEqual([
			{ entryId: "a1", role: "assistant" },
			{ entryId: "u2", role: "user" },
		]);
	});

	it("classifies a spacing or punctuation difference as format", () => {
		const diagnosis = diagnoseQuotes(
			note({
				instructions: [
					{ text: "Vendor rule.", sources: ["u1"], quote: "Keep the service on port 4317. Do not touch vendor/." },
					{ text: "Thursday.", sources: ["u2"], quote: 'Use "deploy only on Thursday" as the ruling.' },
				],
			}),
			branch,
		);
		expect(diagnosis.failures.map((failure) => [failure.kind, failure.foundIn])).toEqual([
			["format", [{ entryId: "u1", role: "user" }]],
			["format", [{ entryId: "u2", role: "user" }]],
		]);
	});

	it("classifies a paraphrase as absent and collects every failure instead of the first", () => {
		const diagnosis = diagnoseQuotes(
			note({
				state: [
					{ text: "Threshold.", sources: ["u3"], quote: "The threshold is 15." },
					{ text: "Threshold.", sources: ["u3"], quote: "The threshold was raised to 15." },
				],
				reasons: [{ text: "Port.", sources: ["u2"], quote: "Keep the service on port 4317." }],
			}),
			branch,
		);
		expect(diagnosis.failures.map((failure) => `${failure.section}[${failure.index}]:${failure.kind}`)).toEqual([
			"reasons[0]:elsewhere",
			"state[1]:absent",
		]);
		expect(quoteCounts(diagnosis.failures)).toEqual({ failed: 2, elsewhere: 1, format: 0, absent: 1 });
	});

	it("reports unreadable sources or supersedes, which rule out a quotation repair", () => {
		expect(diagnoseQuotes(note({ state: [{ text: "x", sources: ["missing"] }] }), branch).unreadable).toBe(true);
		expect(
			diagnoseQuotes(note({ state: [{ text: "x", sources: ["u3"], supersedes: ["missing"] }] }), branch).unreadable,
		).toBe(true);
		expect(diagnoseQuotes(note({}), branch)).toEqual({ failures: [], unreadable: false });
	});

	it("caps the listed locations at five", () => {
		const many = Array.from({ length: 8 }, (_, index) => user(`m${index}`, "Repeated ruling text."));
		const diagnosis = diagnoseQuotes(
			note({ state: [{ text: "Repeated.", sources: ["u3"], quote: "Repeated ruling text." }] }),
			[...branch, ...many],
		);
		expect(diagnosis.failures[0].foundIn.map((location) => location.entryId)).toEqual(["m0", "m1", "m2", "m3", "m4"]);
	});

	it("normalizes only for classification", () => {
		expect(normalizeQuote(" a\u2019b \u201Cc\u201D \u2014 d\n\te ")).toBe('a\'b "c" - d e');
		expect(normalizeQuote("\uFF21\uFF22")).toBe("AB");
	});

	it("keeps quotation text out of messages and names locations in feedback", () => {
		const failures = diagnoseQuotes(
			note({
				reasons: [{ text: "Thursday.", sources: ["u3"], quote: "\u201Cdeploy only on Thursday\u201D" }],
				state: [{ text: "Threshold.", sources: ["u3"], quote: "secret paraphrase" }],
			}),
			branch,
		).failures;
		const message = quoteFailureMessage(quoteCounts(failures));
		expect(message).toBe(
			"CONTEXT_NOTE_QUOTE: 2 quotations do not match the entries cited (1 found verbatim in other entries, 1 found in no entry). No checkpoint committed; original history retained.",
		);
		expect(message).not.toContain("Thursday");
		expect(quoteFailureMessage({ failed: 1, elsewhere: 0, format: 1, absent: 0 }, true)).toBe(
			"CONTEXT_NOTE_QUOTE: 1 quotation does not match the entries cited (1 matching only after spacing or punctuation changes) after one quotation repair. No checkpoint committed; original history retained.",
		);
		expect(quoteFeedback(failures).split("\n")).toEqual([
			"reasons[0].quote is not in u3; the exact text is in a1 (assistant), u2 (user). Cite that entry, or drop the quote. Text from an assistant or tool entry is not a user ruling.",
			"state[0].quote is in no readable entry; quote exact text from a cited entry or drop the quote.",
		]);
	});
});

function response(value: unknown): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
		stopReason: "stop",
		timestamp: 2,
		usage: structuredClone(usage),
	};
}

function stream(message: AssistantMessage) {
	const result = createAssistantMessageEventStream();
	if (message.stopReason === "aborted") result.push({ type: "error", reason: "aborted", error: message });
	else result.push({ type: "done", reason: "stop", message });
	result.end(message);
	return result;
}

/** Answers each writer call in order and records every request's text. */
function quoteHarness(answers: unknown[], changes: Partial<WriteMemoryOptions> = {}) {
	const prompts: string[] = [];
	const requests = vi.fn<PreviewWriterRegistry["streamSimple"]>((_model, context) => {
		prompts.push(
			[context.systemPrompt ?? "", ...context.messages.map((message) => JSON.stringify(message.content))].join("\n"),
		);
		const answer = answers.shift();
		if (answer === undefined) throw new Error("unexpected writer call");
		return stream(typeof answer === "function" ? answer() : response(answer));
	});
	const progress: WriterProgress[] = [];
	const options: WriteMemoryOptions = {
		config: { ...DEFAULT_MEMORY_CONFIG, writerModel: `${model.provider}/${model.id}`, writerEffort: "low" },
		registry: { find: () => model, hasConfiguredAuth: () => true, streamSimple: requests },
		increments: [],
		uncovered: branch,
		branch,
		noteTokens: 2000,
		signal: new AbortController().signal,
		onProgress: (value) => progress.push(value),
		...changes,
	};
	return { options, requests, prompts, progress };
}

describe("preview writer quotation failures", () => {
	it("refuses a misattributed quotation with counts in the message and in status progress", async () => {
		const test = quoteHarness(
			[note({ instructions: [{ text: "Port rule.", sources: ["u3"], quote: "Keep the service on port 4317." }] })],
			{ config: { ...DEFAULT_MEMORY_CONFIG, writerModel: "preview-quote-test/quote-writer", noteRepair: false } },
		);
		await expect(writeMemory(test.options)).rejects.toThrow(
			"CONTEXT_NOTE_QUOTE: 1 quotation does not match the entries cited (1 found verbatim in other entries).",
		);
		expect(test.requests).toHaveBeenCalledTimes(1);
		expect(test.progress.at(-1)).toMatchObject({
			writerCalls: 1,
			repairUsed: false,
			quotations: { failed: 1, elsewhere: 1, format: 0, absent: 0 },
		});
	});

	it("leaves other validation failures unclassified", async () => {
		const test = quoteHarness([note({ state: [{ text: "x", sources: ["missing"] }] })]);
		await expect(writeMemory(test.options)).rejects.toThrow("CONTEXT_NOTE_SCOPE");
		expect(test.progress.at(-1)?.quotations).toBeUndefined();
	});
});

const misattributed = (): MemoryNote =>
	note({
		instructions: [{ text: "Port rule.", sources: ["u3"], quote: "Keep the service on port 4317." }],
		state: [
			{ text: "The threshold is 15.", sources: ["u3"], quote: "The threshold is 15." },
			{ text: "Line one.\nLine two.", sources: ["u2"] },
		],
	});

function repairOf(fact: NoteFact | null, section = "instructions", index = 0) {
	return { repairs: [{ section, index, fact }] };
}

describe("preview writer quotation repair", () => {
	it("re-cites a quotation found in another entry with one request about that fact only", async () => {
		const test = quoteHarness([
			misattributed(),
			repairOf({ text: "Port rule.", sources: ["u1"], quote: "Keep the service on port 4317." }),
		]);
		const result = await writeMemory(test.options);
		expect(test.requests).toHaveBeenCalledTimes(2);
		expect(result.note.instructions).toEqual([
			{ text: "Port rule.", sources: ["u1"], quote: "Keep the service on port 4317." },
		]);
		// Untouched facts come back unchanged, folded onto one line like any committed note.
		expect(result.note.state).toEqual([
			{ text: "The threshold is 15.", sources: ["u3"], quote: "The threshold is 15." },
			{ text: "Line one. Line two.", sources: ["u2"] },
		]);
		expect(() => validateNote(result.note, branch, 2000)).not.toThrow();
		const repairPrompt = test.prompts[1];
		expect(repairPrompt).toContain("Correct the quotations of a memory candidate");
		expect(repairPrompt).toContain('\\"problem\\":\\"elsewhere\\"');
		expect(repairPrompt).toContain('\\"entryId\\":\\"u1\\",\\"role\\":\\"user\\"');
		// Only the failing fact is asked about.
		expect(repairPrompt).not.toContain("Line two");
		const last = test.progress.at(-1);
		expect(last).toMatchObject({
			writerCalls: 2,
			repairUsed: true,
			repairKind: "quotation",
			quotations: { failed: 1, elsewhere: 1, format: 0, absent: 0 },
			quotationRepair: { requoted: 1, unquoted: 0, dropped: 0 },
		});
		expect(last?.writerCallDetails.map((call) => call.phase)).toEqual(["generate", "repair"]);
	});

	it("copies a format-only difference exactly, or drops the quote, or withdraws the fact", async () => {
		const format = note({
			instructions: [
				{ text: "Vendor.", sources: ["u1"], quote: "Keep the service on port 4317. Do not touch vendor/." },
			],
		});
		const exact = quoteHarness([
			format,
			repairOf({ text: "Vendor.", sources: ["u1"], quote: "Keep the service on port 4317.\nDo not touch vendor/." }),
		]);
		expect((await writeMemory(exact.options)).note.instructions[0].quote).toBe(
			"Keep the service on port 4317.\nDo not touch vendor/.",
		);
		const absent = note({
			reasons: [{ text: "Threshold raised.", sources: ["u3"], quote: "The threshold was raised to 15." }],
		});
		const unquoted = quoteHarness([absent, repairOf({ text: "Threshold raised.", sources: ["u3"] }, "reasons")]);
		const kept = await writeMemory(unquoted.options);
		expect(kept.note.reasons).toEqual([{ text: "Threshold raised.", sources: ["u3"] }]);
		expect(unquoted.progress.at(-1)?.quotationRepair).toEqual({ requoted: 0, unquoted: 1, dropped: 0 });
		const withdrawn = quoteHarness([absent, repairOf(null, "reasons")]);
		const without = await writeMemory(withdrawn.options);
		expect(without.note.reasons).toEqual([]);
		expect(without.note.state).toEqual(absent.state);
		expect(withdrawn.progress.at(-1)?.quotationRepair).toEqual({
			requoted: 0,
			unquoted: 0,
			dropped: 1,
			droppedFrom: { reasons: 1 },
		});
	});

	it("blocks when the repaired note still fails, naming the repair in the message", async () => {
		const test = quoteHarness([
			misattributed(),
			repairOf({ text: "Port rule.", sources: ["u2"], quote: "Keep the service on port 4317." }),
		]);
		await expect(writeMemory(test.options)).rejects.toThrow(
			"CONTEXT_NOTE_QUOTE: 1 quotation does not match the entries cited (1 found verbatim in other entries) after one quotation repair.",
		);
		expect(test.requests).toHaveBeenCalledTimes(2);
	});

	it("refuses a repair that changes a fact's text or supersedes", async () => {
		const text = quoteHarness([
			misattributed(),
			repairOf({ text: "Port rule, reworded.", sources: ["u1"], quote: "Keep the service on port 4317." }),
		]);
		await expect(writeMemory(text.options)).rejects.toThrow("CONTEXT_NOTE_REPAIR_LOSS");
		const supersedes = quoteHarness([
			misattributed(),
			repairOf({ text: "Port rule.", sources: ["u1"], quote: "Keep the service on port 4317.", supersedes: ["u2"] }),
		]);
		await expect(writeMemory(supersedes.options)).rejects.toThrow("CONTEXT_NOTE_REPAIR_LOSS");
	});

	it("refuses a repair that withdraws an instruction whose quotation a user message contains", async () => {
		// The port rule's quotation is in user entry u1. Withdrawing the rule would commit a note without it, so the
		// note blocks instead; re-citing or dropping the quote stays available.
		const test = quoteHarness([misattributed(), repairOf(null)]);
		await expect(writeMemory(test.options)).rejects.toThrow(
			"CONTEXT_NOTE_REPAIR_LOSS: a quotation repair may not withdraw an instruction whose quotation a user message contains",
		);
		expect(test.requests).toHaveBeenCalledTimes(2);
		expect(test.progress.at(-1)?.quotationRepair).toBeUndefined();
		// The same holds when the writer cited the assistant: the user's message still holds the ruling.
		const cited = note({
			instructions: [{ text: "Port rule.", sources: ["a1"], quote: "Keep the service on port 4317." }],
		});
		await expect(writeMemory(quoteHarness([cited, repairOf(null)]).options)).rejects.toThrow(
			"CONTEXT_NOTE_REPAIR_LOSS",
		);
		const kept = quoteHarness([misattributed(), repairOf({ text: "Port rule.", sources: ["u3"] })]);
		expect((await writeMemory(kept.options)).note.instructions).toEqual([{ text: "Port rule.", sources: ["u3"] }]);
	});

	it("withdraws an instruction no user message supports, and counts withdrawals by section", async () => {
		// The quoted proposal is only in the assistant's entry a1, so it is no user ruling; the threshold quotation
		// is in no entry. Both are the writer's to withdraw.
		const proposal = note({
			instructions: [
				{
					text: "Deploy only on Thursday.",
					sources: ["u2"],
					quote: "Understood: \u201Cdeploy only on Thursday\u201D is my proposal.",
				},
			],
			reasons: [{ text: "Threshold raised.", sources: ["u3"], quote: "The threshold was raised to 15." }],
		});
		expect(diagnoseQuotes(proposal, branch).failures.map((failure) => [failure.kind, failure.foundIn])).toEqual([
			["elsewhere", [{ entryId: "a1", role: "assistant" }]],
			["absent", []],
		]);
		const test = quoteHarness([
			proposal,
			{ repairs: [...repairOf(null).repairs, ...repairOf(null, "reasons").repairs] },
		]);
		const result = await writeMemory(test.options);
		expect(result.note.instructions).toEqual([]);
		expect(result.note.reasons).toEqual([]);
		expect(test.progress.at(-1)?.quotationRepair).toEqual({
			requoted: 0,
			unquoted: 0,
			dropped: 2,
			droppedFrom: { instructions: 1, reasons: 1 },
		});
	});

	it("requires one answer for each failing fact and nothing else", () => {
		const failures = diagnoseQuotes(misattributed(), branch).failures;
		const fact = { text: "Port rule.", sources: ["u1"], quote: "Keep the service on port 4317." };
		expect(() => applyQuoteRepair(misattributed(), failures, { repairs: [] })).toThrow("CONTEXT_NOTE_INVALID");
		expect(() => applyQuoteRepair(misattributed(), failures, repairOf(fact, "state", 0))).toThrow(
			"CONTEXT_NOTE_INVALID",
		);
		expect(() =>
			applyQuoteRepair(misattributed(), failures, {
				repairs: [repairOf(fact).repairs[0], repairOf(fact).repairs[0]],
			}),
		).toThrow("CONTEXT_NOTE_INVALID");
		expect(() => applyQuoteRepair(misattributed(), failures, "not json")).toThrow("CONTEXT_NOTE_INVALID");
	});

	it("does not repair when a cited ID is unreadable, more than five quotations fail, or repair is off", async () => {
		const unreadable = note({
			instructions: [{ text: "Port rule.", sources: ["u3"], quote: "Keep the service on port 4317." }],
			state: [{ text: "x", sources: ["missing"] }],
		});
		const first = quoteHarness([unreadable]);
		await expect(writeMemory(first.options)).rejects.toThrow("CONTEXT_NOTE_QUOTE");
		expect(first.requests).toHaveBeenCalledTimes(1);
		const six = note({
			state: Array.from({ length: 6 }, (_, index) => ({
				text: `Fact ${index}.`,
				sources: ["u3"],
				quote: "Keep the service on port 4317.",
			})),
		});
		const many = quoteHarness([six]);
		await expect(writeMemory(many.options)).rejects.toThrow("6 quotations do not match");
		expect(many.requests).toHaveBeenCalledTimes(1);
		const off = quoteHarness([misattributed()], {
			config: { ...DEFAULT_MEMORY_CONFIG, writerModel: "preview-quote-test/quote-writer", noteRepair: false },
		});
		await expect(writeMemory(off.options)).rejects.toThrow("CONTEXT_NOTE_QUOTE");
		expect(off.requests).toHaveBeenCalledTimes(1);
	});

	it("spends the compaction's one repair: a quotation-repaired note over the hard limit blocks", async () => {
		const large = misattributed();
		large.state.push({ text: "x".repeat(1600), sources: ["u3"] });
		const test = quoteHarness(
			[large, repairOf({ text: "Port rule.", sources: ["u1"], quote: "Keep the service on port 4317." })],
			{ noteTokens: 500 },
		);
		await expect(writeMemory(test.options)).rejects.toThrow("CONTEXT_NOTE_BUDGET");
		expect(test.requests).toHaveBeenCalledTimes(2);
		expect(test.progress.at(-1)).toMatchObject({ repairKind: "quotation", repairUsed: true });
	});

	it("repairs once across fixed-writer chunks", async () => {
		const long = (id: string, parentId: string | null, words: string) =>
			user(id, `${words} ${"filler text for chunking. ".repeat(3200)}`, parentId);
		const chunked = [long("c1", null, "Keep the service on port 4317."), long("c2", "c1", "The threshold is 15.")];
		const bad = (quoteSource: string): MemoryNote => ({
			...note({ state: [{ text: "Port.", sources: [quoteSource], quote: "Keep the service on port 4317." }] }),
		});
		const test = quoteHarness(
			[
				bad("c2"),
				repairOf({ text: "Port.", sources: ["c1"], quote: "Keep the service on port 4317." }, "state"),
				bad("c2"),
			],
			{ uncovered: chunked, branch: chunked, noteTokens: 2000 },
		);
		await expect(writeMemory(test.options)).rejects.toThrow("CONTEXT_NOTE_QUOTE");
		expect(test.progress.at(-1)?.writerCallDetails.map((call) => call.phase)).toEqual([
			"generate",
			"repair",
			"generate",
		]);
	});

	it("keeps both paid calls when the repair is cancelled", async () => {
		const abort = new AbortController();
		const test = quoteHarness(
			[
				misattributed(),
				() => {
					abort.abort(new Error("Synthetic repair cancellation"));
					return { ...response(""), stopReason: "aborted" as const };
				},
			],
			{ signal: abort.signal },
		);
		await expect(writeMemory(test.options)).rejects.toThrow("Synthetic repair cancellation");
		expect(test.progress.at(-1)).toMatchObject({ writerCalls: 2, repairKind: "quotation" });
	});

	it("keeps the stored note shape: a repaired note is an ordinary schema-valid note", async () => {
		const test = quoteHarness([
			misattributed(),
			repairOf({ text: "Port rule.", sources: ["u1"], quote: "Keep the service on port 4317." }),
		]);
		const result = await writeMemory(test.options);
		expect(Object.keys(result.note).sort()).toEqual(Object.keys(noteSchema.properties).sort());
	});
});

describe("session writer quotable originals", () => {
	const active = user("u4", "Now finish the report.", "u3");
	it("keeps whole user messages beside their IDs, newest first within the bound, in conversation order", () => {
		expect(quotableOriginals(branch, undefined, 1000)).toEqual([
			{ entryId: "u1", text: "Keep the service on port 4317.\nDo not touch vendor/." },
			{ entryId: "u2", text: "Use \u201cdeploy only on Thursday\u201d as the ruling." },
			{ entryId: "u3", text: "The threshold is 15." },
		]);
		// u3 and u2 fit; u1 does not and is left out rather than cut.
		const [, second, third] = quotableOriginals(branch, undefined, 1000);
		const bound = textTokens(JSON.stringify(second)) + textTokens(JSON.stringify(third));
		expect(quotableOriginals(branch, undefined, bound).map((item) => item.entryId)).toEqual(["u2", "u3"]);
		expect(quotableOriginals([...branch, active], [active], 1000).map((item) => item.entryId)).toEqual([
			"u1",
			"u2",
			"u3",
		]);
	});

	const long = user("u5", `Long ruling. ${"Keep every report under out/. ".repeat(120)}`, "u3");
	const sessionBranch = [...branch, long];

	function sessionHarness(contextWindow: number) {
		const session = { ...model, contextWindow };
		const test = quoteHarness([note({})], {
			config: { ...DEFAULT_MEMORY_CONFIG, writerModel: SESSION_WRITER },
			sessionModel: session,
			prefix: { messages: [{ role: "user", content: "Earlier conversation.", timestamp: 1 }] },
			uncovered: sessionBranch,
			branch: sessionBranch,
		});
		const instructions: string[] = [];
		const streamSimple = test.options.registry.streamSimple;
		test.options.registry = {
			...test.options.registry,
			streamSimple: (selected, context, request) => {
				const last = context.messages.at(-1);
				if (last && typeof last.content === "string") instructions.push(last.content);
				return streamSimple(selected, context, request);
			},
		};
		return { ...test, instructions };
	}

	it("sends the block in the handover request and drops it before shrinking the manifest", async () => {
		const roomy = sessionHarness(128_000);
		await writeMemory(roomy.options);
		const full = roomy.instructions[0];
		expect(full).toContain("Quotable user messages, complete and verbatim");
		// The list serves quotation; it must not read as the whole task and demote the assistant's announced plan.
		expect(full).toContain(
			"work the assistant announced within the task stays a next step unless a user message withdrew it",
		);
		expect(full).toContain('{"entryId":"u3","text":"The threshold is 15."}');
		expect(full).toContain("The openings only locate entries; never copy a quotation from them.");
		const start = full.indexOf("Quotable user messages");
		const without = full.slice(0, start) + full.slice(full.indexOf("Entry IDs for citations"));
		// Room for the request without the block, not with it: 4096 output tokens plus the prefix message.
		expect(textTokens(full) - textTokens(without)).toBeGreaterThan(500);
		const tight = sessionHarness(4096 + textTokens(without) + 100);
		await writeMemory(tight.options);
		expect(tight.instructions[0]).not.toContain("Quotable user messages");
		expect(tight.instructions[0]).toContain("u1 user: Keep the service on port 4317. Do not touch vendor/.");
	});
});

describe("work-note quotation feedback", () => {
	it("names the field and where the quoted text actually is", () => {
		expect(() =>
			validateWorkNote(
				{ state: [{ text: "Port rule.", sources: ["u3"], quote: "Keep the service on port 4317." }] },
				branch,
			),
		).toThrow(
			"CONTEXT_NOTE_QUOTE: a quoted source does not match the original text\nstate[0].quote is not in u3; the exact text is in u1 (user).",
		);
	});
});

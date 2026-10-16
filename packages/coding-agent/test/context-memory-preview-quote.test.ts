import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	type Usage,
} from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_MEMORY_CONFIG } from "../src/extensions/context-memory/config.ts";
import type { MemoryNote, NoteFact } from "../src/extensions/context-memory/notes.ts";
import {
	diagnoseQuotes,
	normalizeQuote,
	quoteCounts,
	quoteFailureMessage,
	quoteFeedback,
} from "../src/extensions/context-memory/preview/quote-diagnostics.ts";
import {
	type PreviewWriterRegistry,
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
	result.push({ type: "done", reason: "stop", message });
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
		return stream(response(answer));
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

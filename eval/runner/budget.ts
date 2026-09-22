import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { CallRecord, ForwardedOptions, ProbeLimits, RequestScope, Transport } from "./types.ts";

export class ProbeBudget {
	readonly limits: ProbeLimits;
	actions = 0;
	toolRounds = 0;
	outputTokens = 0;
	calls = 0;
	error?: string;
	constructor(limits: ProbeLimits) {
		this.limits = limits;
	}
	fail(code: string): never {
		this.error ??= code;
		throw new Error(this.error);
	}
	assert(): void {
		if (this.error) throw new Error(this.error);
	}
	action(): void {
		this.assert();
		if (this.actions >= this.limits.actions) this.fail("EVAL_ACTION_LIMIT");
		this.actions++;
	}
	reserveOutput(): number {
		this.assert();
		if (this.calls >= this.limits.calls) this.fail("EVAL_CALL_LIMIT");
		const left = this.limits.outputTokens - this.outputTokens;
		if (left <= 0) this.fail("EVAL_OUTPUT_LIMIT");
		this.calls++;
		return left;
	}
	observe(message: AssistantMessage): void {
		const output = message.usage?.output;
		if (!Number.isSafeInteger(output) || output < 0) this.fail("EVAL_OUTPUT_USAGE_MISSING");
		if (output === 0 && message.content.some((part) => part.type !== "text" || part.text.length > 0))
			this.fail("EVAL_OUTPUT_USAGE_MISSING");
		this.outputTokens += output;
		if (this.outputTokens > this.limits.outputTokens) this.fail("EVAL_OUTPUT_LIMIT");
		if (message.content.some((part) => part.type === "toolCall")) {
			if (this.toolRounds >= this.limits.toolRounds) this.fail("EVAL_TOOL_ROUND_LIMIT");
			this.toolRounds++;
		}
	}
}
export interface RunMeter {
	calls: number;
	maxCalls: number;
	deadline: number;
	scope?: RequestScope;
	writerTimeoutMs?: number;
	writerOutputTokens?: number;
}
export async function measuredRequest(input: {
	transport: Transport;
	purpose: "writer" | "task";
	context: Context;
	model: Model<Api>;
	maxTokens: number;
	signal?: AbortSignal;
	reasoning?: SimpleStreamOptions["reasoning"];
	meter: RunMeter;
	records: CallRecord[];
	budget?: ProbeBudget;
	providerOptions?: ForwardedOptions;
}): Promise<AssistantMessage> {
	input.budget?.assert();
	if (input.signal?.aborted) throw new Error("EVAL_REQUEST_ABORTED");
	if (input.meter.calls >= input.meter.maxCalls) throw new Error("EVAL_RUN_CALL_LIMIT");
	if (performance.now() >= input.meter.deadline) throw new Error("EVAL_RUN_TIMEOUT");
	const providerLimit =
		input.purpose === "writer" ? (input.meter.writerOutputTokens ?? input.maxTokens) : input.maxTokens;
	const remaining = input.budget?.reserveOutput() ?? providerLimit;
	const maxTokens = Math.min(providerLimit, remaining);
	const controller = new AbortController();
	const deadline = Math.min(
		input.meter.deadline - performance.now(),
		input.budget?.limits.timeoutMs ?? input.meter.writerTimeoutMs ?? 60000,
	);
	const abort = () => controller.abort();
	input.signal?.addEventListener("abort", abort, { once: true });
	if (input.signal?.aborted) controller.abort();
	const record: CallRecord = {
		purpose: input.purpose,
		at: performance.now(),
		maxTokens,
		reasoning: input.reasoning,
		context: structuredClone(input.context),
		providerOptions: input.providerOptions,
		usage: null,
		outputTokens: null,
	};
	input.records.push(record);
	input.meter.calls++;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const result = await Promise.race([
			input.transport.complete({
				purpose: input.purpose,
				context: structuredClone(input.context),
				model: structuredClone(input.model),
				maxTokens,
				reasoning: input.reasoning,
				signal: controller.signal,
				scope: structuredClone(input.meter.scope),
				providerOptions: input.providerOptions,
			}),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => {
						controller.abort();
						reject(new Error("EVAL_REQUEST_TIMEOUT"));
					},
					Math.max(1, deadline),
				);
			}),
		]);
		record.usage = result.usage ?? null;
		record.outputTokens = result.usage?.output ?? null;
		record.result = structuredClone(result);
		if (controller.signal.aborted) throw new Error("EVAL_REQUEST_ABORTED");
		input.budget?.observe(result);
		return result;
	} catch (error) {
		record.error = String(error);
		if (/EVAL_REQUEST_TIMEOUT|EVAL_REQUEST_ABORTED/.test(record.error))
			input.transport.stop?.("EVAL_REQUEST_TIMEOUT");
		if (record.error.includes("EVAL_OUTPUT_USAGE_MISSING")) record.outputTokens = null;
		if (input.budget) input.budget.error ??= record.error;
		throw error;
	} finally {
		record.providerMeasurement = input.transport.measurement?.();
		if (timer) clearTimeout(timer);
		input.signal?.removeEventListener("abort", abort);
		record.ms = performance.now() - record.at;
	}
}

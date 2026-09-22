import { readFileSync } from "node:fs";
import type { Api, AssistantMessage, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { streamSimple } from "../../packages/ai/src/api/openai-codex-responses.ts";
import { normalizeContext } from "../../packages/ai/src/utils/transcript.ts";
import { readStoredCredential } from "../../packages/coding-agent/src/core/auth-storage.ts";
import type { ProviderMeasurement, Transport, TransportRequest } from "../runner/types.ts";
import { assertExecutionMode, MODEL_ID } from "./contract.ts";
import { ResponseDiagnostics } from "./diagnostics.ts";
import type { Ledger, Quota, Reservation } from "./ledger.ts";

type Fetch = NonNullable<SimpleStreamOptions["fetch"]>;
function object(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function count(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
export function lunaModel(): Model<"openai-codex-responses"> {
	const data = JSON.parse(
		readFileSync(new URL("../../packages/ai/src/providers/data/openai-codex.json", import.meta.url), "utf8"),
	);
	return structuredClone(data["openai-codex-responses"][MODEL_ID]);
}
export function codexAccess(): string {
	const value = readStoredCredential("openai-codex");
	if (!value || value.type !== "oauth" || !value.access || !value.refresh || value.expires <= Date.now())
		throw new Error("EVAL_CODEX_CREDENTIAL_UNAVAILABLE_OR_EXPIRED");
	return value.access;
}
export function rawMeasurement(
	response: unknown,
): Omit<ProviderMeasurement, "sent" | "capMode" | "inputProxy" | "reservedInput"> {
	const usage = object(object(response).usage),
		details = object(usage.input_tokens_details),
		out = object(usage.output_tokens_details);
	return {
		input: count(usage.input_tokens),
		output: count(usage.output_tokens),
		reasoning: count(out.reasoning_tokens),
		cacheRead: count(details.cached_tokens),
		cacheWrite: count(details.cache_write_tokens),
		total: count(usage.total_tokens),
	};
}
/** Read usage alongside the provider parser, without copying credentials, headers, or full event streams. */
function observeSse(
	response: Response,
	terminal: (value: unknown) => void,
	diagnostics: ResponseDiagnostics,
): Response {
	if (!response.body) return response;
	const decoder = new TextDecoder();
	let buffer = "";
	const consume = (text: string) => {
		buffer += text;
		let end: number;
		while ((end = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, end).trim();
			buffer = buffer.slice(end + 1);
			diagnostics.line(line);
			if (!line.startsWith("data:") || line === "data: [DONE]") continue;
			let event: Record<string, unknown>;
			try {
				event = object(JSON.parse(line.slice(5).trim()));
			} catch {
				continue;
			}
			if (
				["response.completed", "response.incomplete", "response.failed", "response.done"].includes(
					String(event.type),
				)
			)
				terminal(event.response);
		}
	};
	return new Response(
		response.body.pipeThrough(
			new TransformStream<Uint8Array, Uint8Array>({
				transform(chunk, controller) {
					consume(decoder.decode(chunk, { stream: true }));
					controller.enqueue(chunk);
				},
				flush() {
					consume(decoder.decode() + "\n\n");
				},
			}),
		),
		{ status: response.status, statusText: response.statusText, headers: response.headers },
	);
}
export interface CodexOptions {
	mode: "scripted" | "live";
	ledger: Ledger;
	groups: (request: TransportRequest) => Quota[];
	access: () => string;
	fetch?: Fetch;
	onRequest?: (payload: Record<string, unknown>, request: TransportRequest) => void;
}
/** The pinned provider remains unchanged; all policy lives in this explicit evaluator transport. */
export function codexTransport(options: CodexOptions): Transport {
	assertExecutionMode(options.mode);
	if (options.mode === "scripted" && !options.fetch) throw new Error("EVAL_OFFLINE_FETCH_REQUIRED");
	const ledger = options.ledger;
	let latest: ProviderMeasurement | undefined;
	let activeAbort: (() => void) | undefined;
	return {
		mode: options.mode,
		measurement: () => (latest ? structuredClone(latest) : undefined),
		stop(reason) {
			ledger.halt(reason);
			activeAbort?.();
			ledger.event({ type: "stop", reason });
		},
		async complete(request) {
			latest = undefined;
			ledger.assert();
			if (
				request.model.id !== MODEL_ID ||
				request.model.provider !== "openai-codex" ||
				request.model.api !== "openai-codex-responses" ||
				request.reasoning !== "max"
			)
				ledger.stop("EVAL_MODEL_CONFIGURATION_DRIFT");
			let reservation: Reservation | undefined, terminalResponse: unknown, status: number | undefined;
			let diagnostics: ResponseDiagnostics | undefined;
			let sent = false,
				inputProxy = 0,
				message: AssistantMessage | undefined;
			const groups = options.groups(request);
			const own = new AbortController();
			const abort = () => own.abort();
			request.signal.addEventListener("abort", abort, { once: true });
			ledger.cancellation.signal.addEventListener("abort", abort, { once: true });
			if (ledger.cancellation.signal.aborted) abort();
			if (request.signal.aborted) abort();
			activeAbort = abort;
			const timeout = Math.max(
				1,
				Math.min(
					request.purpose === "writer" ? 180000 : request.purpose === "task" ? 120000 : 60000,
					...groups.map((q) => q.deadline - performance.now()),
				),
			);
			const timer = setTimeout(abort, timeout);
			try {
				const access = options.access(); // Intentionally kept only in this call's memory.
				diagnostics = new ResponseDiagnostics([access]);
				const fetch: Fetch = async (url, init) => {
					if (String(url) !== "https://chatgpt.com/backend-api/codex/responses" || !reservation || sent)
						ledger.stop("EVAL_UNEXPECTED_PROVIDER_REQUEST");
					ledger.sent(reservation!);
					sent = true;
					if (latest) latest.sent = true;
					const response = await (options.fetch ?? globalThis.fetch)(url, {
						...init,
						redirect: "error",
						signal: own.signal,
					});
					status = response.status;
					await diagnostics!.response(response);
					ledger.event({ type: "http-response", scope: request.scope, diagnostics: diagnostics!.snapshot() });
					return observeSse(
						response,
						(value) => {
							terminalResponse = value;
						},
						diagnostics!,
					);
				};
				message = await streamSimple(
					request.model as Model<"openai-codex-responses">,
					normalizeContext(request.context),
					{
						apiKey: access,
						reasoning: "max",
						maxTokens: request.maxTokens,
						signal: own.signal,
						transport: "sse",
						maxRetries: 0,
						timeoutMs: timeout,
						toolChoice: request.providerOptions?.toolChoice ?? (request.purpose === "judge" ? "none" : "auto"),
						cacheRetention: request.providerOptions?.cacheRetention ?? "short",
						sessionId: request.providerOptions?.sessionId,
						fetch,
						onPayload(payload) {
							const body = structuredClone(object(payload));
							if (
								object(body.reasoning).effort !== "max" ||
								body.model !== MODEL_ID ||
								body.store !== false ||
								body.previous_response_id !== undefined
							)
								ledger.stop("EVAL_PAYLOAD_CONFIGURATION_DRIFT");
							if (ledger.capMode !== "local-post-response") body.max_output_tokens = request.maxTokens;
							inputProxy = Math.ceil(Buffer.byteLength(JSON.stringify(body), "utf8") / 3);
							reservation = ledger.admit(
								groups,
								inputProxy,
								request.maxTokens,
								request.purpose === "judge" ? 32000 : 160000,
							);
							latest = {
								...rawMeasurement(undefined),
								sent: false,
								capMode: ledger.capMode,
								inputProxy,
								reservedInput: reservation.input,
							};
							options.onRequest?.(structuredClone(body), request);
							return body;
						},
					},
				).result();
				const measured = rawMeasurement(terminalResponse);
				latest = { ...measured, sent, capMode: ledger.capMode, inputProxy, reservedInput: reservation?.input ?? 0 };
				if (reservation) ledger.settle(reservation, measured.input, measured.output);
				else ledger.stop("EVAL_REQUEST_NOT_ADMITTED");
				if (
					status !== 200 ||
					message.stopReason === "error" ||
					message.stopReason === "aborted" ||
					own.signal.aborted
				)
					ledger.stop(status ? `EVAL_PROVIDER_HTTP_${status}` : "EVAL_PROVIDER_TRANSPORT_FAILURE");
				if (measured.output === 0 && message.content.length) ledger.stop("EVAL_OUTPUT_USAGE_UNAVAILABLE");
				if (measured.output! > request.maxTokens) ledger.fallback("returned-output-exceeds-requested-cap");
				else if (count(object(terminalResponse).max_output_tokens) !== request.maxTokens)
					ledger.fallback("server-cap-not-confirmed");
				else if (ledger.capMode !== "local-post-response") ledger.capMode = "server-reported-cap";
				latest.capMode = ledger.capMode;
				ledger.event({
					type: "usage",
					purpose: request.purpose,
					scope: request.scope,
					measurement: latest,
					stopReason: message.stopReason,
				});
				if (measured.output! > request.maxTokens) throw new Error("EVAL_PROVIDER_OUTPUT_LIMIT");
				return message;
			} catch (error) {
				const measured = rawMeasurement(terminalResponse);
				latest ??= {
					...measured,
					sent,
					capMode: ledger.capMode,
					inputProxy,
					reservedInput: reservation?.input ?? 0,
				};
				// Never persist provider error text: it can contain server echoes, headers, or tokens.
				const code =
					ledger.fatal ??
					(error instanceof Error && /^EVAL_[A-Z0-9_:.-]+$/.test(error.message)
						? error.message
						: "EVAL_PROVIDER_TRANSPORT_FAILURE");
				latest.error = code;
				if (sent && reservation && !reservation.settled) {
					try {
						ledger.settle(reservation, measured.input, measured.output);
					} catch {
						/* fatal state is already durable */
					}
				}
				if (code !== "EVAL_PROVIDER_OUTPUT_LIMIT") ledger.halt(code);
				ledger.event({ type: "request-failed", reason: code, sent, scope: request.scope, measurement: latest });
				throw new Error(code);
			} finally {
				if (diagnostics) {
					const snapshot = diagnostics.snapshot();
					if (latest) latest.diagnostics = snapshot;
					ledger.event({ type: "response-diagnostics", scope: request.scope, diagnostics: snapshot });
				}
				clearTimeout(timer);
				request.signal.removeEventListener("abort", abort);
				ledger.cancellation.signal.removeEventListener("abort", abort);
				activeAbort = undefined;
			}
		},
	};
}

/** Response-only diagnostics; secrets stay in the redactor closure, never in its snapshot. */
export function redactor(secrets: readonly string[]): (value: unknown) => string {
	const variants = [
		...new Set(secrets.filter(Boolean).flatMap((s) => [s, encodeURIComponent(s), Buffer.from(s).toString("base64")])),
	].sort((a, b) => b.length - a.length);
	const sensitive = new Set([
		"authorization",
		"proxyauthorization",
		"access",
		"accesstoken",
		"refresh",
		"refreshtoken",
		"idtoken",
		"apikey",
		"cookie",
		"setcookie",
		"password",
		"chatgptaccountid",
		"credentials",
		"token",
	]);
	const scrubText = (value: string) => {
		let text = value;
		for (const secret of variants) text = text.split(secret).join("[REDACTED]");
		return text
			.replace(
				/((?:authorization|proxy-authorization|access_token|refresh_token|id_token|api[_-]?key|cookie|set-cookie|password|chatgpt-account-id)\s*["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n,}]+)/gi,
				'$1"[REDACTED]"',
			)
			.replace(/\bBearer\s+[^\s,"'}]+/gi, "Bearer [REDACTED]")
			.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_JWT]")
			.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_KEY]");
	};
	const walk = (value: unknown): unknown => {
		if (typeof value === "string") return scrubText(value);
		if (Array.isArray(value)) return value.map(walk);
		if (value && typeof value === "object")
			return Object.fromEntries(
				Object.entries(value).map(([key, item]) => [
					key,
					sensitive.has(key.toLowerCase().replace(/[_-]/g, "")) ? "[REDACTED]" : walk(item),
				]),
			);
		return value;
	};
	return (value) => {
		if (typeof value !== "string") return JSON.stringify(walk(value)) ?? String(value);
		try {
			return JSON.stringify(walk(JSON.parse(value)));
		} catch {
			return scrubText(value);
		}
	};
}
function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
export class ResponseDiagnostics {
	private frame: string[] = [];
	private frameSize = 0;
	readonly scrub: (value: unknown) => string;
	httpStatus: number | null = null;
	contentType: string | null = null;
	errorBody: string | null = null;
	terminalTypes: string[] = [];
	eventTypes: string[] = [];
	parseErrors: string[] = [];
	usageCandidates: { eventType: string; path: string; value: unknown }[] = [];
	constructor(secrets: readonly string[]) {
		this.scrub = redactor(secrets);
	}
	line(text: string) {
		if (text.startsWith("data:")) {
			this.frame.push(text.slice(5).trimStart());
			this.frameSize += text.length;
			return;
		}
		if (text !== "" || !this.frame.length) return;
		const data = this.frameSize <= 1048576 ? this.frame.join("\n") : "[oversize SSE frame omitted]";
		this.frame = [];
		this.frameSize = 0;
		if (data === "[DONE]") return;
		let event: Record<string, unknown>;
		try {
			event = record(JSON.parse(data));
		} catch {
			if (this.parseErrors.length < 4) this.parseErrors.push(this.scrub(data).slice(0, 512));
			return;
		}
		const type = this.scrub(event.type ?? "<missing>").slice(0, 128);
		if (this.eventTypes.length < 4096) this.eventTypes.push(type);
		if (
			[
				"response.completed",
				"response.incomplete",
				"response.failed",
				"response.done",
				"error",
				"response.error",
			].includes(type) &&
			this.terminalTypes.length < 32
		)
			this.terminalTypes.push(type);
		if (event.error !== undefined || type === "error")
			this.errorBody = this.scrub(event.error ?? event).slice(0, 16384);
		const response = record(event.response);
		if (response.error !== undefined && response.error !== null)
			this.errorBody = this.scrub(response.error).slice(0, 16384);
		for (const [path, value] of [
			["usage", event.usage],
			["response.usage", response.usage],
		] as const) {
			if (value !== undefined && this.usageCandidates.length < 16) {
				const clean = this.scrub(value);
				let parsed: unknown;
				try {
					parsed = JSON.parse(clean);
				} catch {
					parsed = clean;
				}
				this.usageCandidates.push({ eventType: type, path, value: parsed });
			}
		}
	}
	async response(response: Response) {
		this.httpStatus = response.status;
		this.contentType = this.scrub(response.headers.get("content-type") ?? "").slice(0, 256);
		if (response.ok && this.contentType.toLowerCase().includes("text/event-stream")) return;
		const reader = response.clone().body?.getReader();
		if (!reader) return;
		const chunks: Uint8Array[] = [];
		let size = 0;
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				size += value.byteLength;
				if (size > 65536) {
					this.errorBody = "[error body over 65536 bytes omitted]";
					void reader.cancel().catch(() => undefined);
					return;
				}
				chunks.push(value);
			}
			this.errorBody = this.scrub(Buffer.concat(chunks).toString("utf8")).slice(0, 16384);
		} catch {
			this.errorBody = "[error body read failed]";
		}
	}
	snapshot() {
		return {
			httpStatus: this.httpStatus,
			contentType: this.contentType,
			errorBody: this.errorBody,
			terminalEventTypes: this.terminalTypes,
			eventTypes: this.eventTypes,
			parseErrors: this.parseErrors,
			usageCandidates: this.usageCandidates,
			requestHeadersPersisted: false,
			redacted: true,
		};
	}
}

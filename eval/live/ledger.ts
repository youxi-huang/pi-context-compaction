import type { Limits } from "./contract.ts";

export class Quota {
	readonly name: string;
	readonly limits: Limits;
	readonly deadline: number;
	calls = 0;
	sent = 0;
	knownInput = 0;
	knownOutput = 0;
	inputProxy = 0;
	reservedInput = 0;
	reservedOutput = 0;
	constructor(name: string, limits: Limits) {
		this.name = name;
		this.limits = limits;
		this.deadline = performance.now() + limits.milliseconds;
	}
	snapshot() {
		return {
			name: this.name,
			limits: this.limits,
			calls: this.calls,
			sent: this.sent,
			knownInput: this.knownInput,
			knownOutput: this.knownOutput,
			inputProxy: this.inputProxy,
			reservedInput: this.reservedInput,
			reservedOutput: this.reservedOutput,
		};
	}
}
export interface Reservation {
	groups: Quota[];
	input: number;
	output: number;
	settled: boolean;
}
export class Ledger {
	fatal?: string;
	capMode: "requested-unverified" | "server-reported-cap" | "local-post-response" = "requested-unverified";
	fallbackReason?: string;
	readonly events: Record<string, unknown>[] = [];
	readonly groups: Quota[] = [];
	readonly save?: (event: Record<string, unknown>) => void;
	constructor(save?: (event: Record<string, unknown>) => void) {
		this.save = save;
	}
	event(event: Record<string, unknown>) {
		const row = { at: new Date().toISOString(), ...event };
		this.events.push(row);
		this.save?.(row);
	}
	group(name: string, limits: Limits) {
		const q = new Quota(name, limits);
		this.groups.push(q);
		return q;
	}
	stop(code: string): never {
		this.fatal ??= code;
		this.event({ type: "stop", reason: this.fatal });
		throw new Error(this.fatal);
	}
	assert() {
		if (this.fatal) throw new Error(this.fatal);
	}
	admit(groups: Quota[], proxy: number, output: number, inputCap: number): Reservation {
		this.assert();
		const input = Math.ceil(proxy * 1.5) + 2048;
		if (!Number.isSafeInteger(output) || output < 1 || !Number.isSafeInteger(proxy) || proxy < 0)
			this.stop("EVAL_INVALID_RESERVATION");
		if (input > inputCap) this.stop("EVAL_REQUEST_INPUT_LIMIT");
		for (const q of groups) {
			if (performance.now() >= q.deadline) this.stop(`EVAL_TIME_LIMIT:${q.name}`);
			if (q.calls >= q.limits.calls) this.stop(`EVAL_CALLS_LIMIT:${q.name}`);
			if (q.knownInput + q.reservedInput + input > q.limits.input || q.inputProxy + proxy > q.limits.input)
				this.stop(`EVAL_INPUT_LIMIT:${q.name}`);
			if (q.knownOutput + q.reservedOutput + output > q.limits.output) this.stop(`EVAL_OUTPUT_LIMIT:${q.name}`);
		}
		for (const q of groups) {
			q.calls++;
			q.inputProxy += proxy;
			q.reservedInput += input;
			q.reservedOutput += output;
		}
		this.event({
			type: "admit",
			groups: groups.map((q) => q.name),
			inputProxy: proxy,
			reservedInput: input,
			reservedOutput: output,
		});
		return { groups, input, output, settled: false };
	}
	sent(r: Reservation) {
		for (const q of r.groups) q.sent++;
		this.event({ type: "sent", groups: r.groups.map((q) => q.name) });
	}
	settle(r: Reservation, input: number | null, output: number | null) {
		if (r.settled) throw new Error("EVAL_DOUBLE_SETTLEMENT");
		r.settled = true;
		if (input === null || output === null) this.stop("EVAL_USAGE_UNAVAILABLE");
		for (const q of r.groups) {
			q.reservedInput -= r.input;
			q.reservedOutput -= r.output;
			q.knownInput += input;
			q.knownOutput += output;
		}
		this.event({ type: "settle", input, output, groups: r.groups.map((q) => q.name) });
		if (input > r.input) this.stop("EVAL_INPUT_RESERVATION_OVERRUN");
		for (const q of r.groups) {
			if (performance.now() >= q.deadline) this.stop(`EVAL_TIME_LIMIT:${q.name}`);
			if (q.knownInput + q.reservedInput > q.limits.input) this.stop(`EVAL_INPUT_LIMIT:${q.name}`);
			if (q.knownOutput + q.reservedOutput > q.limits.output) this.stop(`EVAL_OUTPUT_LIMIT:${q.name}`);
		}
	}
	fallback(reason: string) {
		if (this.capMode !== "local-post-response") {
			this.capMode = "local-post-response";
			this.fallbackReason = reason;
			this.event({ type: "authorized-cap-fallback", reason });
		}
	}
	snapshot() {
		return {
			fatal: this.fatal,
			capMode: this.capMode,
			fallbackReason: this.fallbackReason,
			groups: this.groups.map((q) => q.snapshot()),
			events: this.events,
		};
	}
}

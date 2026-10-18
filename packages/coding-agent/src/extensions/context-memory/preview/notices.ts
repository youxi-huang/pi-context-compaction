import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PRIMARY_PI_VERSION, SUPPORTED_PI_LABEL, supportsPi } from "./compatibility.ts";
import type { InactiveReason, PreviewDiagnosis } from "./contracts.ts";

export const NOTICE_PREFIX = "Source-linked compaction";
const RETRY = "Run /compact to try again.";
const NEW_SESSION = "Keep this session file and continue in a new session.";
const NEW_TEXT_SESSION = "Keep this session file and continue in a new text-only session.";

interface Advice {
	what: string;
	next: string;
	checkpoint?: boolean;
	compactCannotClear?: boolean;
}

/** Each controlled code answers what happened and what to do next. No provider text, note text or paths. */
const ADVICE: Record<string, Advice> = {
	CONTEXT_BLOCKED: {
		what: "An earlier failure still needs a checked checkpoint.",
		next: RETRY,
	},
	CONTEXT_BUSY: {
		what: "Another operation in this session is still running.",
		next: "Wait until Pi is idle, then run /compact.",
	},
	CONTEXT_COMPACTOR_CONFLICT: {
		what: "Another compactor is handling this session too.",
		next: "Disable the other compactor and restart Pi, then run /compact.",
	},
	CONTEXT_UNSETTLED: {
		what: "The current turn has not finished.",
		next: "Wait for the turn to finish, then run /compact.",
	},
	CONTEXT_PREVIEW_COMPACT_REQUIRED: {
		what: "Pi's context-overflow recovery needs an explicit /compact here.",
		next: "Run /compact.",
		checkpoint: true,
	},
	CONTEXT_NOTE_QUOTE: {
		what: "A quotation in the note doesn't match the message it cites.",
		next: RETRY,
		checkpoint: true,
	},
	CONTEXT_NOTE_SCOPE: {
		what: "The note cites a message you can't read on this branch.",
		next: RETRY,
		checkpoint: true,
	},
	CONTEXT_NOTE_INVALID: {
		what: "The note doesn't match the required format.",
		next: RETRY,
		checkpoint: true,
	},
	CONTEXT_NOTE_BUDGET: {
		what: "The note exceeds its size limit.",
		next: RETRY,
		checkpoint: true,
	},
	CONTEXT_NOTE_FROZEN: {
		what: "The note can't change while compaction is running.",
		next: "Wait until Pi is idle, then run /compact.",
	},
	CONTEXT_NOTE_REPAIR_LOSS: {
		what: "Repairing the note loses information it needs to keep.",
		next: RETRY,
		checkpoint: true,
	},
	CONTEXT_WRITER_FAILED: {
		what: "The writer's response contains no usable note.",
		next: RETRY,
		checkpoint: true,
	},
	CONTEXT_WRITER_UNAVAILABLE: {
		what: "The note writer set in pi-context-memory.json isn't available.",
		next: 'Set writerModel to "session" or a model Pi can reach and restart Pi, then run /compact.',
		checkpoint: true,
	},
	CONTEXT_WRITER_CAPACITY: {
		what: "The original messages and note don't fit the writer's context window.",
		next: "Use a writer with a larger context window, then run /compact.",
		checkpoint: true,
	},
	CONTEXT_RECOVERY_TOO_LARGE: {
		what: "The note and recent messages don't fit the session model's context window.",
		next: "Select a model with a larger context window, then run /compact.",
		checkpoint: true,
	},
	CONTEXT_CAPACITY: {
		what: "The selected model's context window is too small or unknown.",
		next: "Select a model with a larger context window, then run /compact.",
	},
	CONTEXT_COMPACTION_CANCELLED: {
		what: "Compaction is cancelled before a checkpoint is saved.",
		next: RETRY,
		checkpoint: true,
	},
	CONTEXT_SOURCE_CHANGED: {
		what: "The session's original messages no longer match the checked copy.",
		next: "Wait until Pi is idle and run /compact, or keep this session file and continue in a new session.",
	},
	CONTEXT_TOOL_BOUNDARY: {
		what: "A turn or tool call is still unfinished.",
		next: "Let it finish, then run /compact.",
	},
	CONTEXT_NO_CUT: {
		what: "There is no completed history to compact yet.",
		next: "Finish a turn, then run /compact.",
		checkpoint: true,
	},
	CONTEXT_NO_NEW_SOURCE: {
		what: "There is no new history to compact.",
		next: "Finish a new turn, then run /compact.",
		checkpoint: true,
	},
	CONTEXT_NO_MODEL_OR_SOURCE: {
		what: "No model is selected, or there is no completed history to compact.",
		next: "Select a model and finish a turn, then run /compact.",
	},
	CONTEXT_PREVIEW_PENDING: {
		what: "An earlier compaction attempt is incomplete.",
		next: "Run /compact to retry, or /compaction-recover if Pi already saved that checkpoint.",
	},
	CONTEXT_PREVIEW_COMMIT_UNCONFIRMED: {
		what: "Pi may have saved the checkpoint, but it isn't confirmed on disk.",
		next: "Run /compaction-recover, or /compact if recovery is refused.",
	},
	CONTEXT_PREVIEW_MARKER_IO: {
		what: "The compaction failure record in Pi's agent directory can't be read or written.",
		next: "Check free space and permissions in context-memory-preview/, then run /compact.",
	},
	CONTEXT_PREVIEW_MARKER_INVALID: {
		what: "The compaction failure record in Pi's agent directory is unreadable.",
		next: "Run /compact to replace it with a checked checkpoint.",
	},
	CONTEXT_PREVIEW_SESSION_IO: {
		what: "The session file can't be read back.",
		next: "Keep the session file and check disk access, then run /compact.",
	},
	CONTEXT_PREVIEW_SESSION_INVALID: {
		what: "The session file doesn't pass its format or identity checks.",
		next: NEW_SESSION,
		compactCannotClear: true,
	},
	CONTEXT_MIGRATION_REQUIRED: {
		what: "This protected session contains a checkpoint from another compactor that can't be checked here.",
		next: NEW_SESSION,
		compactCannotClear: true,
	},
	CONTEXT_CONFIG: {
		what: "pi-context-memory.json can't be read as a valid configuration.",
		next: "Fix or remove that file, then restart Pi.",
		compactCannotClear: true,
	},
	CONTEXT_INPUT_TOO_LARGE: {
		what: "The next request exceeds the model's input limit.",
		next: "Run /compact.",
	},
	CONTEXT_PAYLOAD_TOO_LARGE: {
		what: "The provider request exceeds the model's context window.",
		next: "Run /compact.",
	},
	CONTEXT_RECOVERY_MISSING: {
		what: "The checked checkpoint is missing from the request, possibly after another extension changes it.",
		next: "Disable extensions that rewrite the context and restart Pi, then run /compact.",
	},
	CONTEXT_NOTE_VERSION: {
		what: "A saved checkpoint has an unsupported or unreadable format.",
		next: NEW_SESSION,
		compactCannotClear: true,
	},
	CONTEXT_CONTINUATION_MISSING: {
		what: "A saved checkpoint is missing an active request or its next step.",
		next: NEW_SESSION,
		compactCannotClear: true,
	},
};

/** A protected session with content or a host the preview cannot check. /compact cannot repair these. */
function unsupportedAdvice(reason: InactiveReason | undefined, version: string): Advice {
	switch (reason) {
		case "host":
			return {
				what: `This protected session needs Pi ${SUPPORTED_PI_LABEL}, and you're using Pi ${version}.`,
				next: `Open this session with Pi ${SUPPORTED_PI_LABEL} and run /compact there, or continue in a new session.`,
				compactCannotClear: true,
			};
		case "image":
			return {
				what: "This protected session contains an image that can't be checked here.",
				next: NEW_TEXT_SESSION,
				compactCannotClear: true,
			};
		case "non-text":
			return {
				what: "This protected session contains a non-text extension message that can't be checked here.",
				next: NEW_TEXT_SESSION,
				compactCannotClear: true,
			};
		case "context-edit":
			return {
				what: "This protected session contains a context edit that can't be checked here.",
				next: NEW_SESSION,
				compactCannotClear: true,
			};
		case "in-memory":
			return {
				what: "This protected session has no session file to check.",
				next: "Start Pi with a saved session.",
				compactCannotClear: true,
			};
		default:
			return {
				what: "An earlier operation in this session isn't supported here.",
				next: "Run /compact to confirm a new checkpoint.",
			};
	}
}

function adviceFor(code: string, reason: InactiveReason | undefined, version: string): Advice {
	if (code === "CONTEXT_PREVIEW_UNSUPPORTED") return unsupportedAdvice(reason, version);
	return (
		ADVICE[code] ?? {
			what: "The session can't be confirmed as safe to continue.",
			next: "Run /compaction-doctor for details.",
		}
	);
}

export function blockedNotice(
	code: string,
	durable: boolean,
	reason?: InactiveReason,
	version = PRIMARY_PI_VERSION,
	repeated = false,
): string {
	const advice = adviceFor(code, reason, version);
	if (repeated) return `${NOTICE_PREFIX}: requests are still paused. ${advice.next} (${code})`;
	const impact = durable
		? advice.compactCannotClear
			? "Requests stay paused in this session."
			: "Requests stay paused, through /reload and restarts, until a checkpoint is saved."
		: "Only this request was stopped.";
	const outcome = advice.checkpoint ? "checkpoint not saved" : durable ? "requests paused" : "request stopped";
	return `${NOTICE_PREFIX}: ${outcome}. ${advice.what} ${impact} ${advice.next} (${code})`;
}

const INACTIVE: Record<InactiveReason, (version: string) => [string, string]> = {
	host: (version) => [
		`you're using Pi ${version}, and it needs Pi ${SUPPORTED_PI_LABEL}`,
		`Use Pi ${SUPPORTED_PI_LABEL} to try it.`,
	],
	"in-memory": () => ["it has no session file", "Start Pi with a saved session to use it."],
	"foreign-checkpoint": () => ["it already has a checkpoint from another compactor", "Start a new session to use it."],
	image: () => ["it contains an image", "Start a new text-only session to use it."],
	"non-text": () => ["it contains a non-text extension message", "Start a new text-only session to use it."],
	"context-edit": () => ["it contains an unsupported context edit", "Start a new session to use it."],
};

/** The preview stands aside: nothing was written and Pi's own behavior applies. */
export function inactiveNotice(reason: InactiveReason, version: string): string {
	const [why, hint] = INACTIVE[reason](version);
	return `${NOTICE_PREFIX} is off in this session because ${why}. Pi's own compaction applies, and nothing was changed. ${hint}`;
}

export interface DoctorSettings {
	/** `enabled: false` in pi-context-memory.json. */
	disabled: boolean;
	configError?: string;
	writerModel?: string;
}

/** A read-only self-check; Pi's own history gate is unknown through the extension API. */
export function doctorReport(diagnosis: PreviewDiagnosis, settings: DoctorSettings): string {
	const lines = [`${NOTICE_PREFIX} doctor (read-only: no model call, nothing written)`];
	const line = (label: string, result: string, detail: string) => lines.push(`  ${label}: ${result} - ${detail}`);
	const reason = diagnosis.reason;
	const inactive = diagnosis.protection === "not-protected";
	if (settings.disabled) {
		line("extension", "inactive", 'off through "enabled": false in pi-context-memory.json');
		lines.push(
			"Result: off in this session. Pi's own compaction applies. Remove that setting and restart Pi to use source-linked compaction.",
		);
		return lines.join("\n");
	}
	line(
		"extension",
		settings.configError ? "blocked" : "ok",
		settings.configError
			? `pi-context-memory.json can't be read. Fix or remove it, then restart Pi. (${settings.configError})`
			: `loaded, build ${diagnosis.build}`,
	);
	line(
		"host",
		supportsPi(diagnosis.host) ? "ok" : inactive ? "inactive" : "blocked",
		supportsPi(diagnosis.host)
			? `Pi ${diagnosis.host}, supported`
			: `Pi ${diagnosis.host}, needs Pi ${SUPPORTED_PI_LABEL}`,
	);
	if (inactive && reason === "host") {
		line("session", "inactive", "unchecked on this Pi version. Pi's own compaction applies");
	} else if (inactive && reason) {
		line("session", "inactive", `${INACTIVE[reason](diagnosis.host)[0]}. Pi's own compaction applies`);
	} else if (reason) {
		line(
			"session",
			"blocked",
			adviceFor(diagnosis.code ?? "CONTEXT_PREVIEW_UNSUPPORTED", reason, diagnosis.host).what,
		);
	} else {
		line(
			"session",
			"ok",
			diagnosis.protection === "protected"
				? "saved text session, protected"
				: "saved text session, protection starts with /compact",
		);
	}
	if (diagnosis.writerError) {
		const advice = adviceFor(diagnosis.writerError, reason, diagnosis.host);
		line("writer", "blocked", `${advice.what} ${advice.next} (${diagnosis.writerError})`);
	} else if (diagnosis.writer) {
		line(
			"writer",
			"ok",
			settings.writerModel === "session"
				? `session model (${diagnosis.writer})`
				: `configured model (${diagnosis.writer})`,
		);
	} else {
		line("writer", "unknown", settings.configError ? "depends on pi-context-memory.json" : "select a model first");
	}
	const manual = diagnosis.manualCompaction;
	const gate = `Pi may answer "Nothing to compact (session too small)" while keeping ${manual.piDefaultKeepRecentTokens.toLocaleString("en-US")} recent tokens by default (compaction.keepRecentTokens).`;
	const recover = "/compaction-recover can confirm a saved checkpoint without a model call";
	if (manual.preview === "not-active") line("manual /compact", "inactive", "Pi's own compaction applies");
	else if (manual.preview === "blocked") {
		const blocking = diagnosis.code ?? diagnosis.writerError;
		line(
			"manual /compact",
			"blocked",
			blocking
				? `/compact can't clear this here. ${adviceFor(blocking, reason, diagnosis.host).next} (${blocking})`
				: "/compact can't run here yet",
		);
	} else if (manual.preview === "retry")
		line(
			"manual /compact",
			"retry",
			manual.recover ? `${recover}, or run /compact to retry. ${gate}` : `Run /compact to retry. ${gate}`,
		);
	else if (manual.preview === "waiting-for-turn")
		line(
			"manual /compact",
			"unknown",
			`Finish the turn with no queued input first.${manual.recover ? ` ${recover}.` : ""} ${gate}`,
		);
	else line("manual /compact", "unknown", `Ready to try. ${gate}`);
	const durable =
		diagnosis.state === "pending" || (diagnosis.state === "blocked" && diagnosis.protection === "protected");
	if (durable && diagnosis.code) {
		const advice = adviceFor(diagnosis.code, reason, diagnosis.host);
		line("requests", "paused", `${advice.what} ${advice.next} (${diagnosis.code})`);
	} else if (diagnosis.code) {
		const advice = adviceFor(diagnosis.code, reason, diagnosis.host);
		line(
			"requests",
			"ok",
			`not paused. Each request is checked again. ${advice.what} ${advice.next} (${diagnosis.code})`,
		);
	} else {
		line("requests", "ok", "not paused");
	}
	if (inactive) lines.push("Result: off in this session. Pi's own compaction applies, and nothing was changed.");
	else if (diagnosis.code && manual.recover)
		lines.push(
			"Result: requests paused. Run /compaction-recover to confirm the saved checkpoint, or /compact if recovery is refused.",
		);
	else if (diagnosis.code)
		lines.push(
			`Result: ${durable ? "requests paused" : "request stopped"}. ${adviceFor(diagnosis.code, reason, diagnosis.host).next}`,
		);
	else if (diagnosis.writerError)
		lines.push(
			`Result: requests ready, but /compact can't write a checkpoint yet. ${adviceFor(diagnosis.writerError, reason, diagnosis.host).next}`,
		);
	else lines.push("Result: ready. Keep working, then run /compact when the conversation grows.");
	return lines.join("\n");
}

/** /compaction-recover never creates a block; a refusal says what it checked and what to do instead. */
export function recoverRefusedNotice(code: string, reason?: InactiveReason, version = PRIMARY_PI_VERSION): string {
	if (code === "CONTEXT_PREVIEW_COMMIT_UNCONFIRMED") {
		return `${NOTICE_PREFIX}: checkpoint not confirmed. No matching checkpoint saved by Pi can be confirmed. Nothing changes. Run /compact if requests are paused. (${code})`;
	}
	const advice = adviceFor(code, reason, version);
	return `${NOTICE_PREFIX}: checkpoint not confirmed. ${advice.what} Requests keep their current state. ${advice.next} (${code})`;
}

export function readyNotice(): string {
	return `${NOTICE_PREFIX} is on. It writes a checkpoint on /compact and when the context nears its limit. /compaction-doctor checks this session.`;
}

/** Unrequested notices go to the UI, or to stderr so print-mode output stays clean. */
export function notify(ctx: ExtensionContext, text: string, kind: "info" | "warning" | "error"): void {
	try {
		if (ctx.hasUI) ctx.ui.notify(text, kind);
		else console.warn(text);
	} catch {
		// Notices are advisory; markers and request aborts remain authoritative.
	}
}

/**
 * One blocking notice per session for each user input or manual compaction attempt, however many
 * request hooks observe the same block. Informational notices appear once per key.
 */
export class NoticeGate {
	private episode = 0;
	private readonly blocked = new Map<string, number>();
	private readonly fullCode = new Map<string, string>();
	private readonly shown = new Set<string>();

	nextEpisode(): void {
		this.episode++;
	}

	blockedOnce(sessionId: string): boolean {
		if (this.blocked.get(sessionId) === this.episode) return false;
		this.blocked.set(sessionId, this.episode);
		return true;
	}

	repeated(sessionId: string, code: string): boolean {
		const repeated = this.fullCode.get(sessionId) === code;
		this.fullCode.set(sessionId, code);
		return repeated;
	}

	confirmed(sessionId: string): void {
		this.fullCode.delete(sessionId);
	}

	once(key: string): boolean {
		if (this.shown.has(key)) return false;
		this.shown.add(key);
		return true;
	}
}

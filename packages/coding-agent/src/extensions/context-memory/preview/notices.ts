import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PRIMARY_PI_VERSION, SUPPORTED_PI_LABEL, supportsPi } from "./compatibility.ts";
import type { InactiveReason, PreviewDiagnosis } from "./contracts.ts";

const PREFIX = "context-memory preview";
const RETRY = "run /compact to try again.";
const NEW_SESSION = "keep this session file and continue in a new session.";
const NEW_TEXT_SESSION = "keep this session file and continue in a new text-only session.";

interface Advice {
	what: string;
	next: string;
}

const NOTE_SIZE: Advice = {
	what: "The handover note is larger than its allowed size, so no checkpoint was saved.",
	next: RETRY,
};
const CAPACITY: Advice = {
	what: "The handover note and the retained context do not fit the model's context window.",
	next: "run /compact again; if this repeats, use a model with a larger context window.",
};
const MARKER: Advice = {
	what: "The preview could not read or write its failure record in Pi's agent directory (context-memory-preview/).",
	next: "check free space and permissions there, then run /compact.",
};
const SESSION_FILE: Advice = {
	what: "The session file could not be read back and checked.",
	next: "keep the file and check the disk, then run /compact. If this repeats, continue in a new session.",
};
const TOO_LARGE: Advice = { what: "The next request would exceed the model's input limit.", next: "run /compact." };
const STORED: Advice = { what: "A checkpoint in this session no longer passes its checks.", next: NEW_SESSION };

/** Each controlled code answers what happened and what to do next. No provider text, note text or paths. */
const ADVICE: Record<string, Advice> = {
	CONTEXT_PREVIEW_COMPACT_REQUIRED: {
		what: "Pi tried context-overflow recovery, which needs an explicit compaction in this preview.",
		next: "run /compact.",
	},
	CONTEXT_NOTE_QUOTE: {
		what: "A quotation in the handover note does not appear in the entry it cites, so no checkpoint was saved.",
		next: RETRY,
	},
	CONTEXT_NOTE_SCOPE: {
		what: "The handover note cites an entry that cannot be read on this branch, so no checkpoint was saved.",
		next: RETRY,
	},
	CONTEXT_NOTE_INVALID: {
		what: "The handover note is not valid structured data, so no checkpoint was saved.",
		next: RETRY,
	},
	CONTEXT_NOTE_BUDGET: NOTE_SIZE,
	CONTEXT_NOTE_FROZEN: NOTE_SIZE,
	CONTEXT_NOTE_REPAIR_LOSS: NOTE_SIZE,
	CONTEXT_WRITER_FAILED: {
		what: "The note writer did not return a usable note, so no checkpoint was saved.",
		next: RETRY,
	},
	CONTEXT_WRITER_UNAVAILABLE: {
		what: "The note writer set in pi-context-memory.json is not available.",
		next: 'set writerModel to "session" or to a model Pi can reach, restart Pi, then run /compact.',
	},
	CONTEXT_WRITER_CAPACITY: CAPACITY,
	CONTEXT_RECOVERY_TOO_LARGE: CAPACITY,
	CONTEXT_CAPACITY: CAPACITY,
	CONTEXT_COMPACTION_CANCELLED: { what: "Compaction was cancelled before a checkpoint was saved.", next: RETRY },
	CONTEXT_SOURCE_CHANGED: {
		what: "The session's original entries changed while they were being checked.",
		next: "wait until Pi is idle and run /compact. If this repeats, keep the session file and continue in a new session.",
	},
	CONTEXT_TOOL_BOUNDARY: {
		what: "A turn or tool call is still unfinished.",
		next: "let it finish, then run /compact.",
	},
	CONTEXT_NO_CUT: {
		what: "There is no completed history to compact yet.",
		next: "continue working, then run /compact.",
	},
	CONTEXT_NO_NEW_SOURCE: { what: "There is no new history to compact.", next: "continue working, then run /compact." },
	CONTEXT_NO_MODEL_OR_SOURCE: {
		what: "No model is selected, or there is no completed history to compact.",
		next: "select a model and finish a turn, then run /compact.",
	},
	CONTEXT_PREVIEW_PENDING: {
		what: "An earlier compaction attempt did not finish.",
		next: "run /compact to retry, or /compaction-recover if Pi already saved that checkpoint.",
	},
	CONTEXT_PREVIEW_COMMIT_UNCONFIRMED: {
		what: "Pi may have saved the checkpoint, but the preview could not confirm it on disk.",
		next: "run /compaction-recover; if it is refused, run /compact.",
	},
	CONTEXT_PREVIEW_MARKER_IO: MARKER,
	CONTEXT_PREVIEW_MARKER_INVALID: MARKER,
	CONTEXT_PREVIEW_SESSION_IO: SESSION_FILE,
	CONTEXT_PREVIEW_SESSION_INVALID: SESSION_FILE,
	CONTEXT_MIGRATION_REQUIRED: {
		what: "This protected session now contains a checkpoint from another compactor, which the preview cannot check. Checkpoints are not migrated.",
		next: NEW_SESSION,
	},
	CONTEXT_CONFIG: {
		what: "pi-context-memory.json in Pi's agent directory could not be read.",
		next: "fix or remove that file, then restart Pi.",
	},
	CONTEXT_INPUT_TOO_LARGE: TOO_LARGE,
	CONTEXT_PAYLOAD_TOO_LARGE: TOO_LARGE,
	CONTEXT_RECOVERY_MISSING: {
		what: "The checked checkpoint is missing from the request, possibly because another extension changed the context.",
		next: "disable extensions that rewrite the context, restart Pi, then run /compact.",
	},
	CONTEXT_NOTE_VERSION: STORED,
	CONTEXT_CONTINUATION_MISSING: STORED,
};

/** A protected session with content or a host the preview cannot check. /compact cannot repair these. */
function unsupportedAdvice(reason: InactiveReason | undefined, version: string): Advice {
	switch (reason) {
		case "host":
			return {
				what: `This protected session needs Pi ${SUPPORTED_PI_LABEL}, and this is Pi ${version}.`,
				next: `open this session with Pi ${SUPPORTED_PI_LABEL} and run /compact there to clear the block, or ${NEW_SESSION}`,
			};
		case "image":
			return {
				what: "This protected session now contains an image, which the preview cannot check.",
				next: NEW_TEXT_SESSION,
			};
		case "non-text":
			return {
				what: "This protected session now contains a non-text extension message, which the preview cannot check.",
				next: NEW_TEXT_SESSION,
			};
		case "context-edit":
			return { what: "This protected session contains a context edit the preview cannot check.", next: NEW_SESSION };
		default:
			return {
				what: "An earlier operation in this session was outside what the preview supports.",
				next: "run /compact to confirm a new checkpoint.",
			};
	}
}

function adviceFor(code: string, reason: InactiveReason | undefined, version: string): Advice {
	if (code === "CONTEXT_PREVIEW_UNSUPPORTED") return unsupportedAdvice(reason, version);
	return (
		ADVICE[code] ?? {
			what: "The preview could not confirm that it is safe to continue.",
			next: "run /compaction-doctor for details.",
		}
	);
}

/**
 * What happened, whether work is paused, and the next step. `durable` states that the block
 * survives new input, /reload and restarts; otherwise only the current request was stopped.
 */
export function blockedNotice(
	code: string,
	durable: boolean,
	reason?: InactiveReason,
	version = PRIMARY_PI_VERSION,
): string {
	const advice = adviceFor(code, reason, version);
	const impact = durable
		? "Requests in this session are paused; new input, /reload and restarting Pi do not clear this."
		: "Requests stop until this is fixed; no lasting block is recorded.";
	return `${PREFIX}: ${code}. ${advice.what} ${impact} Next: ${advice.next}`;
}

const INACTIVE: Record<InactiveReason, (version: string) => [string, string]> = {
	host: (version) => [
		`it is validated on Pi ${SUPPORTED_PI_LABEL}, and this is Pi ${version}`,
		`Use Pi ${SUPPORTED_PI_LABEL} to try the preview.`,
	],
	"in-memory": () => ["this session has no session file", "Start Pi with a saved session to use the preview."],
	"foreign-checkpoint": () => [
		"this session already has a checkpoint from Pi's own compaction or another compactor, and checkpoints are not migrated",
		"Start a new session to use source-linked compaction.",
	],
	image: () => [
		"this session contains an image, and the preview supports text-only sessions",
		"Start a new text-only session to use source-linked compaction.",
	],
	"non-text": () => [
		"this session contains a non-text extension message, and the preview supports text-only sessions",
		"Start a new text-only session to use source-linked compaction.",
	],
	"context-edit": () => [
		"this session contains a context edit the preview does not support",
		"Start a new session to use source-linked compaction.",
	],
};

/** The preview stands aside: nothing was written and Pi's own behavior applies. */
export function inactiveNotice(reason: InactiveReason, version: string): string {
	const [why, hint] = INACTIVE[reason](version);
	return `${PREFIX} is not active in this session: ${why}. It has not changed this session, and Pi's own compaction applies here. ${hint}`;
}

export interface DoctorSettings {
	/** `enabled: false` in pi-context-memory.json. */
	disabled: boolean;
	configError?: string;
	writerModel?: string;
}

function sentence(text: string): string {
	return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/**
 * A plain-language self-check built from the read-only diagnosis. Each line is one of the
 * separate conditions a first-time user needs; Pi's own history gate is reported as unknown.
 */
export function doctorReport(diagnosis: PreviewDiagnosis, settings: DoctorSettings): string {
	const lines = [`${PREFIX} doctor (read-only: no model call, nothing written)`];
	const line = (label: string, result: string, detail: string) => lines.push(`  ${label}: ${result} - ${detail}`);
	const reason = diagnosis.reason;
	const inactive = diagnosis.protection === "not-protected";
	if (settings.disabled) {
		line(
			"extension",
			"inactive",
			'turned off by "enabled": false in pi-context-memory.json; Pi\'s own compaction applies',
		);
		lines.push("Result: inactive. Remove that setting and restart Pi to use the preview.");
		return lines.join("\n");
	}
	line(
		"extension",
		settings.configError ? "blocked" : "ok",
		settings.configError
			? `pi-context-memory.json could not be read (${settings.configError}); fix or remove it, then restart Pi`
			: `loaded, build ${diagnosis.build}`,
	);
	line(
		"host",
		supportsPi(diagnosis.host) ? "ok" : inactive ? "inactive" : "blocked",
		supportsPi(diagnosis.host)
			? `Pi ${diagnosis.host}, a validated release`
			: `Pi ${diagnosis.host}; this preview is validated on Pi ${SUPPORTED_PI_LABEL}`,
	);
	if (inactive && reason === "host") {
		line("session", "inactive", "not checked on this Pi version; Pi's own compaction applies");
	} else if (inactive && reason) {
		line("session", "inactive", `${INACTIVE[reason](diagnosis.host)[0]}; Pi's own compaction applies`);
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
				? "persistent text session, protected (it has a preview checkpoint or an attempt record)"
				: "persistent text session, eligible (protected from its first /compact)",
		);
	}
	if (diagnosis.writerError) {
		line(
			"writer",
			"blocked",
			`${diagnosis.writerError}: ${adviceFor(diagnosis.writerError, reason, diagnosis.host).next}`,
		);
	} else if (diagnosis.writer) {
		line(
			"writer",
			"ok",
			settings.writerModel === "session"
				? `the session model (${diagnosis.writer})`
				: `fixed writer ${diagnosis.writer}`,
		);
	} else {
		line(
			"writer",
			"unknown",
			settings.configError ? "depends on pi-context-memory.json" : "no model is selected yet",
		);
	}
	const manual = diagnosis.manualCompaction;
	const tokens =
		manual.contextTokens === null || manual.contextTokens === 0
			? ""
			: ` About ${manual.contextTokens.toLocaleString("en-US")} tokens are in context now.`;
	const gate = `Pi decides whether there is enough older history. It keeps the most recent ${manual.piDefaultKeepRecentTokens.toLocaleString("en-US")} estimated tokens by default (compaction.keepRecentTokens) and answers "Nothing to compact (session too small)" until there is more, which is not a failure.${tokens}`;
	const recover = "/compaction-recover can confirm the checkpoint Pi already saved, without a model call";
	if (manual.preview === "not-active")
		line("manual /compact", "inactive", "handled by Pi's own compaction in this session");
	else if (manual.preview === "blocked") {
		const blocking = diagnosis.code ?? diagnosis.writerError;
		line(
			"manual /compact",
			"blocked",
			blocking
				? `/compact cannot clear ${blocking} here: ${adviceFor(blocking, reason, diagnosis.host).next}`
				: "/compact cannot run here yet",
		);
	} else if (manual.preview === "retry")
		line(
			"manual /compact",
			"retry",
			manual.recover
				? `${recover}; otherwise a new /compact retries. ${gate}`
				: `a new /compact retries, and requests resume once its checkpoint is confirmed on disk. ${gate}`,
		);
	else if (manual.preview === "waiting-for-turn")
		line(
			"manual /compact",
			"unknown",
			`the preview needs a finished turn with no queued input first${manual.recover ? `; ${recover} now` : ""}. ${gate}`,
		);
	else line("manual /compact", "unknown", `the preview is ready; ${gate}`);
	const durable =
		diagnosis.state === "pending" || (diagnosis.state === "blocked" && diagnosis.protection === "protected");
	if (durable && diagnosis.code) {
		const advice = adviceFor(diagnosis.code, reason, diagnosis.host);
		line("durable block", "blocked", `${diagnosis.code}. ${advice.what} Next: ${advice.next}`);
	} else if (diagnosis.code) {
		line("durable block", "ok", `none recorded; ${diagnosis.code} stops each request until its cause is fixed`);
	} else {
		line("durable block", "ok", "none");
	}
	if (inactive) lines.push("Result: inactive. Nothing was changed in this session; Pi's own compaction applies.");
	else if (diagnosis.code && manual.recover)
		lines.push(
			"Result: blocked. Run /compaction-recover to confirm the saved checkpoint; if it is refused, run /compact.",
		);
	else if (diagnosis.code)
		lines.push(`Result: blocked. ${sentence(adviceFor(diagnosis.code, reason, diagnosis.host).next)}`);
	else if (diagnosis.writerError)
		lines.push(
			`Result: ready, but /compact cannot write a checkpoint yet. ${sentence(adviceFor(diagnosis.writerError, reason, diagnosis.host).next)}`,
		);
	else lines.push("Result: ready. Keep working, and run /compact once the conversation has grown.");
	return lines.join("\n");
}

/** /compaction-recover never creates a block; a refusal says what it checked and what to do instead. */
export function recoverRefusedNotice(code: string, reason?: InactiveReason, version = PRIMARY_PI_VERSION): string {
	if (code === "CONTEXT_PREVIEW_COMMIT_UNCONFIRMED") {
		return `${PREFIX}: /compaction-recover found no checkpoint that Pi saved after the preview staged it (${code}), so there is nothing to confirm. It changed nothing. If requests are paused, run /compact to write a new checkpoint.`;
	}
	const advice = adviceFor(code, reason, version);
	return `${PREFIX}: /compaction-recover could not confirm the staged checkpoint (${code}). ${advice.what} Next: ${advice.next}`;
}

export function readyNotice(build: string): string {
	return `${PREFIX} is active (${build}). It compacts on /compact and at Pi's threshold after completed turns; context-overflow recovery needs /compact. Run /compaction-doctor to check this session.`;
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
	private readonly shown = new Set<string>();

	nextEpisode(): void {
		this.episode++;
	}

	blockedOnce(sessionId: string): boolean {
		if (this.blocked.get(sessionId) === this.episode) return false;
		this.blocked.set(sessionId, this.episode);
		return true;
	}

	once(key: string): boolean {
		if (this.shown.has(key)) return false;
		this.shown.add(key);
		return true;
	}
}

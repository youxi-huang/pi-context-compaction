// Split for the host-neutral core (v0.7.0 WP2 step 4): identifier matching, the secret filter,
// `selectExcerpts` and `unusedExcerpts` moved to the core's excerpts.ts, re-exported and widened
// here; `readExcerptSettings`, which reads a settings file, stays with this adapter.
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	type AppendedExcerpt,
	selectExcerpts as coreSelectExcerpts,
	unusedExcerpts as coreUnusedExcerpts,
	type ExcerptItem,
} from "../../../../../compaction-core/src/excerpts.ts";
import type { InContext } from "../../../../../compaction-core/src/history-view.ts";
import type { SessionRecord } from "../../../../../compaction-core/src/records.ts";
import { isRecord } from "../identity.ts";
import { missing, readBoundedFile } from "./failure-io.ts";
import { type PreviewSwitch, previewSwitch } from "./preparation.ts";

export {
	type AppendedExcerpt,
	EXCERPT_CUSTOM_TYPE,
	EXCERPT_LABEL,
	EXCERPT_MAX_COUNT,
	EXCERPT_MAX_TERMS,
	EXCERPT_MAX_TOKENS,
	type ExcerptItem,
	exactOccurrence,
	excerptLine,
	identifierShaped,
	identifierTerms,
	SECRET_PATTERNS,
	secretPattern,
} from "../../../../../compaction-core/src/excerpts.ts";

/** Pi's entries satisfy the core's structural record shapes; the union is widened here, never converted (records.ts). */
const asRecords = (branch: readonly SessionEntry[]): readonly SessionRecord[] =>
	branch as unknown as readonly SessionRecord[];

export interface ExcerptRequest {
	/** The request's messages. An excerpt is considered only when the last one is the user's prompt. */
	messages: readonly AgentMessage[];
	/** Text the request carries outside its messages: the system prompt and tool declarations. */
	outside: readonly string[];
	/** The session branch the context was projected from. */
	branch: readonly SessionEntry[];
	/** Whether an entry's full text is in context; the records it rejects are compacted or reduced. */
	inContext: InContext;
}

export interface ExcerptAppend {
	items: ExcerptItem[];
	/** The custom message appended after the prompt, for this request only. */
	message: AgentMessage;
	/** Estimated tokens of its text: retrieval usage, never writer usage. */
	tokens: number;
}

/**
 * The core's `selectExcerpts` at the Pi boundary: the branch is widened to the structural record
 * shapes, and the appended custom message — built by the core from the host's own prompt fields —
 * returns to the host's message type (the documented reverse pass-through, records.ts).
 */
export function selectExcerpts(request: ExcerptRequest): ExcerptAppend | undefined {
	return coreSelectExcerpts({ ...request, branch: asRecords(request.branch) }) as unknown as ExcerptAppend | undefined;
}

/** The core's `unusedExcerpts` at the Pi boundary; the branch is widened, never converted (records.ts). */
export function unusedExcerpts(appended: readonly AppendedExcerpt[], branch: readonly SessionEntry[]): number {
	return coreUnusedExcerpts(appended, asRecords(branch));
}

const settingsCache = new Map<string, PreviewSwitch>();

/**
 * `previewExcerpts.enabled` in pi-context-memory.json, latched for the process like the other preview switches. Off
 * by default; an invalid value or an unreadable file disables it, and requests go on exactly as without it.
 */
export function readExcerptSettings(agentDir: string): PreviewSwitch {
	const path = join(agentDir, "pi-context-memory.json");
	const cached = settingsCache.get(path);
	if (cached) return cached;
	let result: PreviewSwitch;
	try {
		const value: unknown = JSON.parse(readBoundedFile(path, 64 * 1024, "excerpt-config").toString("utf8"));
		result = previewSwitch((isRecord(value) ? value : {}).previewExcerpts);
	} catch (error) {
		result = missing(error) ? { enabled: false } : { enabled: false, error: "invalid-config" };
	}
	settingsCache.set(path, result);
	return result;
}

/**
 * The structural record types of the specification's record model (spec/specification.md, "The
 * record model"), settled against what the retyped modules actually read: `sourceText` and
 * `sourceRole` in notes.ts, the checkpoint validation walk, and `queryHistory` in history.ts.
 * A host's native record satisfies these shapes — it is not converted into them (rule K4) — and
 * whatever fields the host stores beyond the ones named here travel with the record unchanged.
 * `reduction.ts`'s `ReductionRecord` (lifted into this package) is the established pattern; these types are its
 * closure over the remaining classified modules.
 *
 * The union is closed over the six kinds the core distinguishes. A record of a kind outside it
 * passes through the runtime opaque — it normalizes to empty text and is therefore not citable —
 * but the retyped modules narrow on literal `type` discriminators, so such a record enters typed
 * code through an adapter's own widening, never through this union.
 */

export interface RecordBase {
	/** The host's own identifier; the core never invents a record ID (rule K4). */
	id: string;
	/** The preceding record's ID; null on the first record of a branch. */
	parentId: string | null;
	/** The record model's kind discriminator, stored by hosts as `type`. */
	type: string;
	/** The record's stored creation time, parseable to milliseconds. */
	timestamp: string;
}

/**
 * One content block of a message or auxiliary text. The core recognizes `text` and `toolCall`
 * blocks and readable `text` parts; any other block type is retained opaque and normalizes to a
 * fixed placeholder line, its native fields travelling unchanged through the index signature.
 */
export interface RecordContentBlock {
	[key: string]: unknown;
	type: string;
	/** `text` block. */
	text?: string;
	/** `toolCall` block. */
	id?: string;
	name?: string;
	arguments?: unknown;
}

/**
 * The message fields the core reads across the recognized roles (`user`, `assistant`,
 * `toolResult`, `bashExecution`); any other role normalizes through its `content` field when one
 * exists. A host's native message satisfies this shape.
 */
export interface RecordMessage {
	role: string;
	/** `user`, `assistant` and `toolResult` content: a string, or an array of content blocks. */
	content?: string | RecordContentBlock[];
	/** `assistant`: `stop` is the completed-turn boundary every turn-sensitive rule uses. */
	stopReason?: string;
	errorMessage?: string;
	/** `toolResult`: the paired call's ID. */
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	/** `bashExecution`. */
	command?: string;
	output?: string;
	exitCode?: number;
	fullOutputPath?: string;
	/** A result the user kept out of context is never excerpted. */
	excludeFromContext?: boolean;
}

/** One conversation message. */
export interface MessageRecord extends RecordBase {
	type: "message";
	message: RecordMessage;
}

/** A committed checkpoint; `details` carries the checkpoint format when the checkpoint is this method's. */
export interface CompactionRecord<TDetails = unknown> extends RecordBase {
	type: "compaction";
	/** The stored rendering. */
	summary: string;
	/** The record from which every original stays in context verbatim, or the reserved keep-none value. */
	firstKeptEntryId: string;
	/** The estimated context size the compaction replaced. */
	tokensBefore: number;
	details?: TDetails;
}

/** An extension record, discriminated by `customType`; `context-memory-note` marks a work note. */
export interface CustomRecord<TData = unknown> extends RecordBase {
	type: "custom";
	customType: string;
	data?: TData;
}

/** Auxiliary text shown to the model; `text` parts are readable, other parts normalize to a placeholder. */
export interface CustomMessageRecord extends RecordBase {
	type: "custom_message";
	content: string | RecordContentBlock[];
}

/** A host-written branch summary. */
export interface BranchSummaryRecord extends RecordBase {
	type: "branch_summary";
	summary: string;
}

/** A host's retry omission: `targetId` names the omitted record, `replacement` is null for a pure omission. */
export interface ContextEditRecord extends RecordBase {
	type: "context_edit";
	targetId: string;
	replacement: { content: string | RecordContentBlock[] } | null;
}

/** One record of a branch: the ancestor chain from the session's first record to one leaf. */
export type SessionRecord =
	| MessageRecord
	| CompactionRecord
	| CustomRecord
	| CustomMessageRecord
	| BranchSummaryRecord
	| ContextEditRecord;

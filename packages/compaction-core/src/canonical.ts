import { createHash } from "node:crypto";
import type { RecordMessage, SessionRecord } from "./records.ts";

/** JSON strings must contain Unicode scalar values (RFC 8785 section 3.2.2.2). */
function stringLiteral(value: string): string {
	for (let index = 0; index < value.length; index++) {
		const unit = value.charCodeAt(index);
		if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = value.charCodeAt(++index);
			if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError("JCS: unpaired high surrogate");
		} else if (unit >= 0xdc00 && unit <= 0xdfff) {
			throw new TypeError("JCS: unpaired low surrogate");
		}
	}
	return JSON.stringify(value);
}

/**
 * RFC 8785 JCS for parsed JSON values: ECMAScript number/string serialization, recursive raw
 * UTF-16 key ordering, no Unicode normalization. Reject values JSON cannot represent without
 * loss; never call toJSON. Parsing and duplicate-property rejection belong to the input boundary.
 */
export function canonicalize(value: unknown): string {
	const ancestors = new Set<object>();
	const serialize = (item: unknown): string => {
		if (item === null) return "null";
		if (typeof item === "string") return stringLiteral(item);
		if (typeof item === "boolean") return JSON.stringify(item);
		if (typeof item === "number") {
			if (!Number.isFinite(item)) throw new TypeError("JCS: non-finite number");
			return JSON.stringify(item);
		}
		if (typeof item !== "object") throw new TypeError("JCS: expected a JSON value");
		if (ancestors.has(item)) throw new TypeError("JCS: cyclic value");
		ancestors.add(item);
		try {
			if (Array.isArray(item)) {
				const values: string[] = [];
				for (let index = 0; index < item.length; index++) values.push(serialize(item[index]));
				return `[${values.join(",")}]`;
			}
			const prototype = Object.getPrototypeOf(item);
			if (prototype !== Object.prototype && prototype !== null) throw new TypeError("JCS: expected a JSON object");
			const object = item as Record<string, unknown>;
			return `{${Object.keys(object)
				.sort()
				.map((key) => `${stringLiteral(key)}:${serialize(object[key])}`)
				.join(",")}}`;
		} finally {
			ancestors.delete(item);
		}
	};
	return serialize(value);
}

const messageFields = [
	"role",
	"content",
	"stopReason",
	"errorMessage",
	"toolCallId",
	"toolName",
	"isError",
	"command",
	"output",
	"exitCode",
	"fullOutputPath",
	"excludeFromContext",
] as const satisfies readonly (keyof RecordMessage)[];

/**
 * H2's normalized form is records.ts's structural fields, not sourceText's lossy citation view.
 * Host-only top-level/message fields are excluded. Opaque JSON payloads (blocks, arguments,
 * details, data and replacements) stay whole. Only absent optional structural fields are omitted.
 */
export function normalizeRecord(record: SessionRecord): Record<string, unknown> {
	const normalized: Record<string, unknown> = {
		id: record.id,
		parentId: record.parentId,
		type: record.type,
		timestamp: record.timestamp,
	};
	switch (record.type) {
		case "message":
			normalized.message = Object.fromEntries(
				messageFields.filter((key) => record.message[key] !== undefined).map((key) => [key, record.message[key]]),
			);
			break;
		case "compaction":
			normalized.summary = record.summary;
			normalized.firstKeptEntryId = record.firstKeptEntryId;
			normalized.tokensBefore = record.tokensBefore;
			if (record.details !== undefined) normalized.details = record.details;
			break;
		case "custom":
			normalized.customType = record.customType;
			if (record.data !== undefined) normalized.data = record.data;
			break;
		case "custom_message":
			normalized.content = record.content;
			break;
		case "branch_summary":
			normalized.summary = record.summary;
			break;
		case "context_edit":
			normalized.targetId = record.targetId;
			normalized.replacement = record.replacement;
			break;
	}
	return normalized;
}

export function serializeCanonicalRecord(record: SessionRecord): string {
	return canonicalize(normalizeRecord(record));
}

/** SHA-256, one normalized JCS record plus LF per frame, hex-encoded (specification H2). */
export function hashCanonicalRecords(records: readonly SessionRecord[]): string {
	const hash = createHash("sha256");
	for (const record of records) hash.update(serializeCanonicalRecord(record)).update("\n");
	return hash.digest("hex");
}

/** Exclusive prefix boundaries, with the same framing as hashCanonicalRecords, in one pass. */
export function hashCanonicalRecordPrefixes(
	records: readonly SessionRecord[],
	prefixLengths: readonly number[],
	onSerializedEntry?: (index: number, serialized: string) => void,
): ReadonlyMap<number, string> {
	const requested = new Set(prefixLengths);
	let last = 0;
	for (const length of requested) {
		if (!Number.isSafeInteger(length) || length < 0 || length > records.length)
			throw new Error("CONTEXT_SOURCE_PREFIX: invalid source prefix boundary");
		last = Math.max(last, length);
	}
	const result = new Map<number, string>();
	const hash = createHash("sha256");
	if (requested.has(0)) result.set(0, hash.copy().digest("hex"));
	for (let index = 0; index < last; index++) {
		const serialized = serializeCanonicalRecord(records[index]);
		hash.update(serialized).update("\n");
		onSerializedEntry?.(index, serialized);
		if (requested.has(index + 1)) result.set(index + 1, hash.copy().digest("hex"));
	}
	return result;
}

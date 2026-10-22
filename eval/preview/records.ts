import type { SessionRecord } from "../../packages/compaction-core/src/records.ts";

/**
 * The host-neutral record format (0.7.0 WP3, decision H6). A records file holds one branch of the specification's
 * record model (packages/compaction-core/spec/specification.md, "The record model"; the shapes are
 * packages/compaction-core/src/records.ts, whose field names this format uses unchanged). Each host's runner converts
 * it into that host's sessions: `pi-session.ts` renders Pi version-3 session JSONL.
 *
 * Layout: UTF-8 JSONL, one file per branch (for the preview fixtures, `fixtures/<ID>/records.jsonl`), each line one
 * `JSON.stringify` value, every line ending in a newline.
 *
 * - Line 1, the header: `{"format": RECORDS_FORMAT, "session": {"id", "timestamp", "cwd"}}`: the session's own ID,
 *   its start time and its working directory, the metadata every host stores once per session.
 * - Every further line, one record, in branch order: `type` (the record model's kind discriminator), `id`,
 *   `parentId` (null on the first record, the previous record's `id` on every other: one linear branch), `timestamp`,
 *   then the kind's own fields (`message` for a `message` record; `summary`, `firstKeptEntryId`, `tokensBefore`,
 *   `details` for a `compaction`; and so on, as records.ts names them).
 * - A `message` record's `message` holds only the fields records.ts's `RecordMessage` names (`role`, `content`,
 *   `stopReason`, `errorMessage`, `toolCallId`, `toolName`, `isError`, `command`, `output`, `exitCode`,
 *   `fullOutputPath`, `excludeFromContext`); content blocks are `{type: "text", text}` and
 *   `{type: "toolCall", id, name, arguments}`.
 * - Optional `native`, last on a record: bytes one host stores that no normalized field derives, keyed by host name
 *   (`native.pi` for Pi), so a converter reproduces the host's native record exactly (rule K4 keeps the native record
 *   beside normalized text). Every converter reads only its own key and rejects keys it does not know; a record
 *   without `native` is rendered from its normalized fields alone.
 *
 * The conformance vectors of WP3 carry their records in the same model and the same field names.
 */
export const RECORDS_FORMAT = "0.7-host-neutral-records.1";

export interface RecordsHeader {
	format: typeof RECORDS_FORMAT;
	session: { id: string; timestamp: string; cwd: string };
}

/** Host-native passthrough, by host name; each host's converter defines and validates its own entry. */
export interface NativePayloads {
	[host: string]: unknown;
}

export type HostNeutralRecord = SessionRecord & { native?: NativePayloads };

export interface RecordsFile {
	header: RecordsHeader;
	records: HostNeutralRecord[];
}

/** The message fields records.ts's `RecordMessage` names; anything a host adds belongs under `native`. */
const MESSAGE_FIELDS = new Set([
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
]);

export function serializeRecords(file: RecordsFile): string {
	assertRecordsFile(file);
	return `${[file.header, ...file.records].map((line) => JSON.stringify(line)).join("\n")}\n`;
}

export function parseRecords(text: string): RecordsFile {
	if (!text.endsWith("\n")) throw new Error("EVAL_RECORDS_NEWLINE");
	const [header, ...records]: unknown[] = text
		.slice(0, -1)
		.split("\n")
		.map((line, index) => {
			try {
				return JSON.parse(line);
			} catch {
				throw new Error(`EVAL_RECORDS_LINE:${index + 1}`);
			}
		});
	const file: unknown = { header, records };
	assertRecordsFile(file);
	return file;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Structural checks of the format; the record model's own rules (citations, pairing) stay with the core. */
export function assertRecordsFile(file: unknown): asserts file is RecordsFile {
	if (!isObject(file) || Object.keys(file).join() !== "header,records" || !Array.isArray(file.records))
		throw new Error("EVAL_RECORDS_FILE");
	const header = file.header;
	if (!isObject(header) || header.format !== RECORDS_FORMAT) throw new Error("EVAL_RECORDS_FORMAT");
	const session = header.session;
	if (
		Object.keys(header).join() !== "format,session" ||
		!isObject(session) ||
		Object.keys(session).join() !== "id,timestamp,cwd" ||
		!Object.values(session).every((value) => typeof value === "string" && value.length > 0)
	)
		throw new Error("EVAL_RECORDS_HEADER");
	const records: unknown[] = file.records;
	if (records.length === 0) throw new Error("EVAL_RECORDS_EMPTY");
	let previous: string | null = null;
	for (const [index, record] of records.entries()) {
		const at = `${index + 1}`;
		if (!isObject(record)) throw new Error(`EVAL_RECORDS_RECORD:${at}`);
		const [type, id, parentId, timestamp] = Object.keys(record);
		if (type !== "type" || id !== "id" || parentId !== "parentId" || timestamp !== "timestamp")
			throw new Error(`EVAL_RECORDS_FIELD_ORDER:${at}`);
		if (typeof record.type !== "string" || typeof record.id !== "string" || record.id.length === 0)
			throw new Error(`EVAL_RECORDS_RECORD:${at}`);
		if (record.parentId !== previous) throw new Error(`EVAL_RECORDS_PARENT:${record.id}`);
		if (typeof record.timestamp !== "string" || !Number.isFinite(Date.parse(record.timestamp)))
			throw new Error(`EVAL_RECORDS_TIMESTAMP:${record.id}`);
		if (record.type === "message") {
			const message = record.message;
			if (!isObject(message) || typeof message.role !== "string") throw new Error(`EVAL_RECORDS_MESSAGE:${record.id}`);
			for (const key of Object.keys(message))
				if (!MESSAGE_FIELDS.has(key)) throw new Error(`EVAL_RECORDS_MESSAGE_FIELD:${record.id}:${key}`);
		}
		if ("native" in record) {
			const keys = Object.keys(record);
			if (keys.at(-1) !== "native" || !isObject(record.native) || !Object.values(record.native).every(isObject))
				throw new Error(`EVAL_RECORDS_NATIVE:${record.id}`);
		}
		previous = record.id;
	}
}

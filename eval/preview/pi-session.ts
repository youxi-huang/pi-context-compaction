import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type HostNeutralRecord, parseRecords, type RecordsFile } from "./records.ts";

/**
 * The Pi converter: renders a host-neutral records file (records.ts) as a Pi version-3 session JSONL file.
 *
 * - The header line is `{"type": "session", "version": 3, "id", "timestamp", "cwd"}` from the records header's
 *   `session`.
 * - A `message` record becomes `{"type", "id", "parentId", "timestamp", "message"}`. Its message takes the normalized
 *   fields in Pi's key order for the role and adds Pi's own: the message `timestamp`, by default the record's
 *   timestamp in milliseconds; and on an assistant message the provider envelope `api`, `provider`, `model` and
 *   `usage`, by default the synthetic provenance every fixture carries (no model wrote any of it).
 * - Any other kind is already Pi's native entry shape (rule K4): its fields pass through in record order.
 *
 * `native.pi.message` overrides those Pi-only message fields where a default does not hold; P1 to P3 stamp every
 * message with the fixed timestamp 1, which no record timestamp derives. Nothing else may sit under `native.pi`,
 * and a message field with no place in Pi's shape for its role fails the conversion rather than being dropped.
 *
 * `--check` is the converter byte-identity check: it converts every committed `fixtures/<ID>/records.jsonl` and
 * compares the SHA-256 of the result with the existing manifests' pin for `<ID>/session.jsonl`, failing on any
 * difference.
 */

const SESSION_VERSION = 3;

const SYNTHETIC_ASSISTANT = {
	api: "openai-completions",
	provider: "synthetic",
	model: "fixture",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
};

/** The Pi-only message fields `native.pi.message` may set. */
const PI_MESSAGE_FIELDS = new Set(["timestamp", "api", "provider", "model", "usage"]);

/** Pi's key order per role; fields not in the record model are the Pi-only ones above. */
const PI_MESSAGE_ORDER: Record<string, readonly string[]> = {
	user: ["role", "content", "timestamp"],
	assistant: ["role", "content", "api", "provider", "model", "stopReason", "errorMessage", "timestamp", "usage"],
	toolResult: ["role", "toolCallId", "toolName", "content", "isError", "timestamp"],
	bashExecution: ["role", "command", "output", "exitCode", "fullOutputPath", "excludeFromContext", "timestamp"],
};

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The record's `native.pi.message`, checked to hold only Pi-only message fields. */
function piMessageNative(record: HostNeutralRecord): Record<string, unknown> {
	const pi = record.native?.pi;
	if (pi === undefined) return {};
	if (!isObject(pi) || record.type !== "message" || Object.keys(pi).join() !== "message" || !isObject(pi.message))
		throw new Error(`EVAL_RECORDS_PI_NATIVE:${record.id}`);
	for (const key of Object.keys(pi.message))
		if (!PI_MESSAGE_FIELDS.has(key)) throw new Error(`EVAL_RECORDS_PI_NATIVE_FIELD:${record.id}:${key}`);
	return pi.message;
}

function piEntry(record: HostNeutralRecord): Record<string, unknown> {
	const override = piMessageNative(record);
	const { native: _native, ...entry } = record;
	if (entry.type !== "message") return entry;
	if (Object.keys(entry).join() !== "type,id,parentId,timestamp,message")
		throw new Error(`EVAL_RECORDS_PI_ENTRY:${record.id}`);
	const message: Record<string, unknown> = { ...entry.message };
	const order = PI_MESSAGE_ORDER[entry.message.role];
	if (!order) throw new Error(`EVAL_RECORDS_PI_ROLE:${record.id}:${entry.message.role}`);
	for (const key of Object.keys(message))
		if (!order.includes(key)) throw new Error(`EVAL_RECORDS_PI_FIELD:${record.id}:${key}`);
	const defaults: Record<string, unknown> = {
		timestamp: Date.parse(entry.timestamp),
		...(entry.message.role === "assistant" ? SYNTHETIC_ASSISTANT : {}),
	};
	const rendered: Record<string, unknown> = {};
	for (const key of order) {
		const value = key in message ? message[key] : key in override ? override[key] : defaults[key];
		if (value !== undefined) rendered[key] = value;
	}
	return { type: entry.type, id: entry.id, parentId: entry.parentId, timestamp: entry.timestamp, message: rendered };
}

export function toPiSession(file: RecordsFile): string {
	const header = { type: "session", version: SESSION_VERSION, ...file.header.session };
	return `${[header, ...file.records.map(piEntry)].map((line) => JSON.stringify(line)).join("\n")}\n`;
}

export const PREVIEW_MANIFESTS = ["manifest.json", "manifest-0.6.json", "manifest-long.json"] as const;

export interface IdentityResult {
	/** Fixture IDs whose converted session matched its pin. */
	matched: string[];
	/** One line per difference: a missing records file, an unreadable one, or a hash that is not the pin. */
	different: string[];
}

/**
 * Converts each fixture's records file and compares it with the session pin of the existing manifests. `read` takes a
 * path relative to the fixtures directory, so a test can substitute records without touching the files.
 */
export function converterIdentity(read: (path: string) => string): IdentityResult {
	const result: IdentityResult = { matched: [], different: [] };
	for (const name of PREVIEW_MANIFESTS) {
		const manifest: unknown = JSON.parse(read(name));
		if (!isObject(manifest) || !isObject(manifest.files)) throw new Error(`EVAL_PREVIEW_MANIFEST:${name}`);
		const sessions = Object.entries(manifest.files).filter(([path]) => path.endsWith("/session.jsonl"));
		if (sessions.length === 0) result.different.push(`${name}: pins no session`);
		for (const [path, pin] of sessions) {
			const id = path.slice(0, -"/session.jsonl".length);
			let converted: string;
			try {
				converted = toPiSession(parseRecords(read(`${id}/records.jsonl`)));
			} catch (error) {
				result.different.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
				continue;
			}
			const hash = createHash("sha256").update(converted).digest("hex");
			if (hash === pin) result.matched.push(id);
			else result.different.push(`${id}: converted ${hash}, ${name} pins ${String(pin)}`);
		}
	}
	return result;
}

function main(): void {
	if (!process.argv.includes("--check")) throw new Error("Usage: pi-session.ts --check");
	const root = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
	const { matched, different } = converterIdentity((path) => readFileSync(join(root, path), "utf8"));
	if (different.length) throw new Error(`EVAL_PREVIEW_CONVERTER_IDENTITY:\n${different.join("\n")}`);
	console.log(`Pi converter identity: ${matched.join(", ")} match their pinned session hashes.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

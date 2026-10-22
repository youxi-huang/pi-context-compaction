import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generate } from "./generate.ts";
import { converterIdentity, toPiSession } from "./pi-session.ts";
import { type HostNeutralRecord, parseRecords, RECORDS_FORMAT, type RecordsFile, serializeRecords } from "./records.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const FIXTURES = ["P1", "P2", "P3", "P4"];
/** The Pi message fields the record model does not name. */
const PI_ONLY = ["api", "provider", "model", "usage", "timestamp"];

/** The committed fixture files, with some replaced. */
const reader =
	(replace: Record<string, string> = {}) =>
	(path: string) =>
		replace[path] ?? read(path);

describe("host-neutral fixture records and the Pi converter", () => {
	it("convert, from the committed records alone, to every pinned session hash for hash", () => {
		const { matched, different } = converterIdentity(reader());
		expect(different).toEqual([]);
		expect(matched).toEqual(FIXTURES);
		const pins = { ...JSON.parse(read("manifest.json")).files, ...JSON.parse(read("manifest-0.6.json")).files };
		for (const id of FIXTURES) {
			const converted = toPiSession(parseRecords(read(`${id}/records.jsonl`)));
			expect(converted, id).toBe(read(`${id}/session.jsonl`));
			expect(createHash("sha256").update(converted).digest("hex"), id).toBe(pins[`${id}/session.jsonl`]);
		}
	});

	it("are what the generator emits, and round-trip byte for byte", () => {
		const files = generate();
		for (const id of FIXTURES) {
			const text = files.get(`${id}/records.jsonl`)!;
			expect(text, id).toBe(read(`${id}/records.jsonl`));
			expect(serializeRecords(parseRecords(text)), id).toBe(text);
			expect(files.get(`${id}/session.jsonl`), id).toBe(toPiSession(parseRecords(text)));
		}
	});

	it("hold only the record model's fields, with Pi's bytes passed through only where nothing derives them", () => {
		for (const id of FIXTURES) {
			const { header, records } = parseRecords(read(`${id}/records.jsonl`));
			expect(header.format).toBe(RECORDS_FORMAT);
			const session = JSON.parse(read(`${id}/session.jsonl`).split("\n")[0]);
			expect(session).toEqual({ type: "session", version: 3, ...header.session });
			for (const record of records) {
				expect(record.type).toBe("message");
				if (record.type !== "message") continue;
				for (const key of PI_ONLY) expect(Object.keys(record.message), record.id).not.toContain(key);
				// P4 keeps a clock, so Pi's message timestamp derives from the record's; P1 to P3 stamp a fixed 1.
				if (id === "P4") expect(record.native, record.id).toBeUndefined();
				else expect(record.native, record.id).toEqual({ pi: { message: { timestamp: 1 } } });
			}
		}
	});

	it("fail the identity check on any changed byte of a records file", () => {
		const original = read("P2/records.jsonl");
		const edited = original.replace("Correct the low-stock threshold to 15", "Correct the low-stock threshold to 16");
		expect(edited).not.toBe(original);
		const changed = converterIdentity(reader({ "P2/records.jsonl": edited }));
		expect(changed.matched).toEqual(["P1", "P3", "P4"]);
		expect(changed.different).toHaveLength(1);
		expect(changed.different[0]).toMatch(/^P2: converted [0-9a-f]{64}, manifest\.json pins [0-9a-f]{64}$/);
		// Dropping the native payload changes Pi's message timestamps, so it fails too.
		const derived = read("P1/records.jsonl").replaceAll(',"native":{"pi":{"message":{"timestamp":1}}}', "");
		expect(converterIdentity(reader({ "P1/records.jsonl": derived })).different[0]).toMatch(/^P1: converted/);
		const missing = converterIdentity((path) => {
			if (path === "P4/records.jsonl") throw new Error("ENOENT");
			return read(path);
		});
		expect(missing.different).toEqual(["P4: ENOENT"]);
	});

	it("reject records outside the format rather than drop or invent bytes", () => {
		const file = parseRecords(read("P4/records.jsonl"));
		const first = file.records[0];
		const withRecords = (records: unknown[]): string =>
			`${[file.header, ...records].map((line) => JSON.stringify(line)).join("\n")}\n`;
		const message = first.type === "message" ? first.message : undefined;
		expect(() => parseRecords(withRecords([{ ...first, message: { ...message, api: "x" } }]))).toThrow(
			"EVAL_RECORDS_MESSAGE_FIELD:p4-00001:api",
		);
		expect(() => parseRecords(withRecords([{ ...first, parentId: "p4-00000" }]))).toThrow("EVAL_RECORDS_PARENT");
		expect(() => parseRecords(withRecords(file.records.slice(1)))).toThrow("EVAL_RECORDS_PARENT");
		expect(() => parseRecords(withRecords([{ ...first, native: { pi: { message: { timestamp: 1 } } }, extra: 1 }]))).toThrow(
			"EVAL_RECORDS_NATIVE",
		);
		const convert = (record: HostNeutralRecord) => toPiSession({ header: file.header, records: [record] });
		expect(() => convert({ ...first, native: { pi: { message: { role: "user" } } } })).toThrow(
			"EVAL_RECORDS_PI_NATIVE_FIELD:p4-00001:role",
		);
		expect(() => convert({ ...first, native: { pi: { entry: {} } } })).toThrow("EVAL_RECORDS_PI_NATIVE:p4-00001");
		if (first.type === "message")
			expect(() => convert({ ...first, message: { ...first.message, toolCallId: "call" } })).toThrow(
				"EVAL_RECORDS_PI_FIELD:p4-00001:toolCallId",
			);
	});

	it("render a kind other than message as Pi's own entry, unchanged", () => {
		const header = parseRecords(read("P1/records.jsonl")).header;
		const record: HostNeutralRecord = {
			type: "compaction",
			id: "c-1",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			summary: "s",
			firstKeptEntryId: "c-1",
			tokensBefore: 3,
		};
		const file: RecordsFile = { header, records: [record] };
		expect(toPiSession(parseRecords(serializeRecords(file))).split("\n")[1]).toBe(JSON.stringify(record));
	});
});

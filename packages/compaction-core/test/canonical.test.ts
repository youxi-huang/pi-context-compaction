import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	canonicalize,
	hashCanonicalRecordPrefixes,
	hashCanonicalRecords,
	normalizeRecord,
	serializeCanonicalRecord,
} from "../src/canonical.ts";
import { hashEntries } from "../src/identity.ts";
import type { SessionRecord } from "../src/records.ts";

const base = { id: "r1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z" };
const record: SessionRecord = { ...base, type: "message", message: { role: "user", content: "Synthetic evidence." } };

describe("RFC 8785 canonical JSON", () => {
	it("matches the section 3.2.2 serialization example", () => {
		const value = {
			numbers: [Number("333333333.33333329"), 1e30, 4.5, 2e-3, 1e-27],
			string: '€$\u000f\nA\'B"\\\\"/',
			literals: [null, true, false],
		};
		expect(canonicalize(value)).toBe(
			'{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
		);
	});

	it("sorts raw UTF-16 keys, including numeric-looking keys, recursively without reordering arrays", () => {
		const value = { "\ufb33": 7, "😀": 6, "€": 5, ö: 4, "\u0080": 3, "1": 2, "\r": 1 };
		expect(canonicalize(value)).toBe('{"\\r":1,"1":2,"\u0080":3,"ö":4,"€":5,"😀":6,"דּ":7}');
		expect(canonicalize({ z: [{ "2": 2, "10": 10 }, 1], a: { z: 2, a: 1 } })).toBe(
			'{"a":{"a":1,"z":2},"z":[{"10":10,"2":2},1]}',
		);
	});

	it.each([
		[-0, "0"],
		[Number.MIN_VALUE, "5e-324"],
		[-Number.MIN_VALUE, "-5e-324"],
		[Number.MAX_VALUE, "1.7976931348623157e+308"],
		[9007199254740992, "9007199254740992"],
		[1e21, "1e+21"],
		[1e20, "100000000000000000000"],
		[1e-6, "0.000001"],
		[1e-7, "1e-7"],
	] as const)("uses ECMAScript number serialization for %s", (value, expected) => {
		expect(canonicalize(value)).toBe(expected);
	});

	it("escapes controls and preserves Unicode without normalization", () => {
		expect(canonicalize('\b\t\n\f\r\u0000/\\"😀')).toBe('"\\b\\t\\n\\f\\r\\u0000/\\\\\\"😀"');
		expect(canonicalize("é")).not.toBe(canonicalize("e\u0301"));
	});

	it.each([
		NaN,
		Infinity,
		-Infinity,
		undefined,
		1n,
		() => 1,
		Symbol("invalid"),
		new Date(0),
		new Map(),
		[undefined],
		{ x: undefined },
		Array(1),
		"\ud800",
		"\udfff",
		{ "\ud800": 1 },
	])("rejects non-JSON or invalid Unicode input %#", (value) => expect(() => canonicalize(value)).toThrow(TypeError));

	it("rejects cycles and toJSON hooks but permits repeated non-cyclic objects", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(() => canonicalize(cyclic)).toThrow(TypeError);
		let called = false;
		expect(() =>
			canonicalize({
				toJSON: () => {
					called = true;
					return null;
				},
			}),
		).toThrow(TypeError);
		expect(called).toBe(false);
		const shared = { a: 1 };
		expect(canonicalize([shared, shared])).toBe('[{"a":1},{"a":1}]');
	});
});

describe("canonical source hashes", () => {
	it("frames known normalized bytes with one LF, while Pi retains native field ordering", () => {
		const bytes =
			'{"id":"r1","message":{"content":"Synthetic evidence.","role":"user"},"parentId":null,"timestamp":"2026-01-01T00:00:00.000Z","type":"message"}';
		expect(serializeCanonicalRecord(record)).toBe(bytes);
		expect(hashCanonicalRecords([record])).toBe(createHash("sha256").update(`${bytes}\n`).digest("hex"));
		const reordered: SessionRecord = {
			type: "message",
			message: { content: "Synthetic evidence.", role: "user" },
			...base,
		};
		expect(hashCanonicalRecords([reordered])).toBe(hashCanonicalRecords([record]));
		expect(hashEntries([reordered])).not.toBe(hashEntries([record]));
	});

	it("includes all modeled record payloads and omits only optional or host-only fields", () => {
		const variants: SessionRecord[] = [
			record,
			{
				...base,
				type: "compaction",
				summary: "Synthetic summary",
				firstKeptEntryId: "r1",
				tokensBefore: 12,
				details: { opaque: [1, null] },
			},
			{ ...base, type: "custom", customType: "synthetic", data: { opaque: "data" } },
			{ ...base, type: "custom_message", content: [{ type: "opaque", value: 3 }] },
			{ ...base, type: "branch_summary", summary: "Synthetic branch" },
			{
				...base,
				type: "context_edit",
				targetId: "r1",
				replacement: { content: [{ type: "text", text: "Synthetic edit" }] },
			},
		];
		for (const value of variants) {
			const withHostFields = { ...value, hostOnly: "not modeled" };
			expect(normalizeRecord(withHostFields)).toEqual(value);
		}
		const message: SessionRecord = {
			...base,
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "c1", name: "synthetic", arguments: { z: 2, a: 1 } }],
				stopReason: "toolUse",
				errorMessage: "synthetic",
				toolCallId: "c1",
				toolName: "synthetic",
				isError: false,
				command: "synthetic",
				output: "result",
				exitCode: 0,
				fullOutputPath: "synthetic-output",
				excludeFromContext: false,
			},
		};
		expect(normalizeRecord(message)).toEqual(message);
		const withExtra = { ...record, message: { ...record.message, stopReason: undefined, providerOnly: 9 } };
		expect(normalizeRecord(withExtra)).toEqual(record);
		for (const [key, value] of Object.entries(message.message)) {
			const changed = { ...message, message: { ...message.message, [key]: value === false ? true : "changed" } };
			expect(hashCanonicalRecords([changed])).not.toBe(hashCanonicalRecords([message]));
		}
	});

	it("matches every exclusive prefix in one pass, including empty, repeated and unordered boundaries", () => {
		const records = [record, { ...record, id: "r2", parentId: "r1" }, { ...record, id: "r3", parentId: "r2" }];
		const seen: number[] = [];
		const hashes = hashCanonicalRecordPrefixes(records, [2, 0, 1, 2], (index, bytes) => {
			seen.push(index);
			expect(bytes).toBe(serializeCanonicalRecord(records[index]));
		});
		expect(seen).toEqual([0, 1]);
		for (const length of [0, 1, 2]) expect(hashes.get(length)).toBe(hashCanonicalRecords(records.slice(0, length)));
		expect(hashCanonicalRecordPrefixes(records, []).size).toBe(0);
		expect(hashCanonicalRecords([])).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
		expect(hashCanonicalRecords(records.slice(0, 2).reverse())).not.toBe(hashes.get(2));
	});

	it.each([-1, 0.5, 2, Infinity])("rejects invalid prefix %s as a caller invariant", (length) => {
		expect(() => hashCanonicalRecordPrefixes([record], [length])).toThrow("CONTEXT_SOURCE_PREFIX");
	});
});

import { createHash } from "node:crypto";
import {
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSessionProjection, type SessionEntry, type SessionHeader } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as identity from "../src/extensions/context-memory/identity.ts";
import { type MemoryNote, renderNote, validateMemoryCheckpoints } from "../src/extensions/context-memory/notes.ts";
import type { PreviewBranchSnapshot, PreviewSession } from "../src/extensions/context-memory/preview/contracts.ts";
import * as failureIo from "../src/extensions/context-memory/preview/failure-io.ts";
import {
	createPreviewBranchSnapshot,
	PreviewFailureStore,
} from "../src/extensions/context-memory/preview/failure-store.ts";

const timestamp = "2026-01-01T00:00:00.000Z";

function user(id: string, parentId: string | null, content = "Synthetic port is 4317."): SessionEntry {
	return { type: "message", id, parentId, timestamp, message: { role: "user", content, timestamp: 1 } };
}

class ReadbackSession implements PreviewSession {
	readonly header: SessionHeader;
	readonly file: string;
	readonly root: string;
	entries: SessionEntry[] = [user("source", null), user("leaf", "source", "Synthetic next instruction.")];
	leafId: string | null = "leaf";
	constructor(root: string) {
		this.root = root;
		this.file = join(root, "synthetic-session.jsonl");
		this.header = { type: "session", version: 3, id: "synthetic-session", timestamp, cwd: root };
		this.persist();
	}
	persist(entries: readonly unknown[] = this.entries): void {
		this.persistLines(entries.map((entry) => JSON.stringify(entry)));
	}
	persistLines(lines: readonly string[]): void {
		writeFileSync(this.file, `${[JSON.stringify(this.header), ...lines].join("\n")}\n`);
	}
	getCwd() {
		return this.root;
	}
	getSessionDir() {
		return this.root;
	}
	getSessionId() {
		return this.header.id;
	}
	getSessionFile() {
		return this.file;
	}
	getLeafId() {
		return this.leafId;
	}
	getLeafEntry() {
		return this.getEntry(this.leafId ?? "");
	}
	getEntry(id: string) {
		return this.entries.find((entry) => entry.id === id);
	}
	getLabel(_id: string) {
		return undefined;
	}
	getHeader() {
		return this.header;
	}
	getEntries() {
		return [...this.entries];
	}
	getTree() {
		return [];
	}
	getSessionName() {
		return undefined;
	}
	getBranch(fromId?: string): SessionEntry[] {
		let entry = this.getEntry(fromId ?? this.leafId ?? "");
		const branch: SessionEntry[] = [];
		const visited = new Set<string>();
		while (entry && !visited.has(entry.id)) {
			visited.add(entry.id);
			branch.unshift(entry);
			entry = this.getEntry(entry.parentId ?? "");
		}
		return branch;
	}
	buildContextEntries() {
		return this.getBranch();
	}
	buildSessionProjection() {
		return buildSessionProjection(this.getBranch());
	}
}

/** Only the caller's current synchronous invocation owns these objects and serialized lines. */
function snapshot(session: ReadbackSession): PreviewBranchSnapshot {
	const branch = session.getBranch();
	const collector = createPreviewBranchSnapshot(branch);
	// Match the ordered shared scan even when this branch cannot receive a hint.
	for (const [index, entry] of branch.entries()) {
		const serialized = JSON.stringify(entry);
		collector?.onSerializedEntry(index, serialized);
	}
	return collector?.snapshot ?? { branch, canonicalLines: [] };
}

describe("preview request readback: invocation-owned canonical lines", () => {
	let root: string;
	let agentDir: string;
	let session: ReadbackSession;
	let store: PreviewFailureStore;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-preview-readback-"));
		agentDir = join(root, "agent");
		session = new ReadbackSession(root);
		store = new PreviewFailureStore(agentDir);
	});
	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(root, { recursive: true, force: true });
	});

	it("parses the fresh header but skips branch parsing and both hashes on exact lines", () => {
		const current = snapshot(session);
		const parse = vi.spyOn(JSON, "parse");
		const hashes = vi.spyOn(identity, "hashEntries");
		expect(() => store.assertReady(session, current)).not.toThrow();
		expect(parse).toHaveBeenCalledTimes(1);
		expect(hashes).not.toHaveBeenCalled();
	});

	it("reads the whole JSONL again for every invocation and creates no failure marker", () => {
		const bytes = readFileSync(session.file);
		const read = vi.spyOn(failureIo, "readBoundedFile");
		store.assertReady(session, snapshot(session));
		store.assertReady(session, snapshot(session));
		expect(read.mock.calls.filter(([file]) => file === session.file)).toHaveLength(2);
		expect(readFileSync(session.file)).toEqual(bytes);
		expect(store.markerPresent(session)).toBe(false);
	});

	it("never treats manually constructed canonical bytes as a factory-owned proof", () => {
		const branch = session.getBranch();
		const unbranded = { branch, canonicalLines: branch.map((entry) => Buffer.from(JSON.stringify(entry), "utf8")) };
		const parse = vi.spyOn(JSON, "parse");
		const hashes = vi.spyOn(identity, "hashEntries");
		expect(() => store.assertReady(session, unbranded)).not.toThrow();
		expect(parse).toHaveBeenCalledTimes(3);
		expect(hashes).toHaveBeenCalledTimes(2);
	});

	it.each(["partial", "out-of-order", "after-complete"])(
		"does not authorize a %s factory collection as a complete byte proof",
		(kind) => {
			const branch = session.getBranch();
			const collector = createPreviewBranchSnapshot(branch);
			if (!collector) throw new Error("Missing synthetic collector");
			if (kind === "out-of-order") collector.onSerializedEntry(1, JSON.stringify(branch[1]));
			collector.onSerializedEntry(0, JSON.stringify(branch[0]));
			if (kind === "after-complete") {
				collector.onSerializedEntry(1, JSON.stringify(branch[1]));
				collector.onSerializedEntry(0, JSON.stringify(branch[0]));
			}
			const parse = vi.spyOn(JSON, "parse");
			const hashes = vi.spyOn(identity, "hashEntries");
			expect(() => store.assertReady(session, collector.snapshot)).not.toThrow();
			expect(parse).toHaveBeenCalledTimes(3);
			expect(hashes).toHaveBeenCalledTimes(2);
		},
	);

	it.each(["toJSON", "getter", "proxy"])(
		"preflights the complete branch without invoking a %s hook or trap",
		(kind) => {
			const later = session.entries[1];
			if (later.type !== "message") throw new Error("Missing synthetic source");
			const hook = vi.fn(() => {
				throw new Error("Synthetic preflight must not call source hooks");
			});
			if (kind === "toJSON") Object.defineProperty(later, "toJSON", { value: hook });
			if (kind === "getter") Object.defineProperty(later.message, "content", { enumerable: true, get: hook });
			if (kind === "proxy")
				later.message = new Proxy(later.message, { get: hook, getPrototypeOf: hook, ownKeys: hook });
			expect(createPreviewBranchSnapshot(session.getBranch())).toBeUndefined();
			expect(hook).not.toHaveBeenCalled();
		},
	);

	it.each(["array", "object"])(
		"does not execute an inherited %s index setter through its own preflight work arrays",
		(kind) => {
			const branch = session.getBranch();
			const original = session.entries[0];
			if (original.type !== "message" || original.message.role !== "user")
				throw new Error("Missing synthetic source");
			const originalMessage = original.message;
			const prototype = kind === "array" ? Array.prototype : Object.prototype;
			const previousLength = Array.prototype.length;
			let calls = 0;
			let observedCalls = -1;
			let result: ReturnType<typeof createPreviewBranchSnapshot>;
			Object.defineProperty(prototype, "0", {
				configurable: true,
				set(this: object, value: unknown) {
					calls++;
					originalMessage.content = "Synthetic port is 4318.";
					Object.defineProperty(this, "0", { value, configurable: true, enumerable: true, writable: true });
				},
			});
			try {
				result = createPreviewBranchSnapshot(branch);
				observedCalls = calls;
			} finally {
				Reflect.deleteProperty(prototype, "0");
				if (kind === "array") Array.prototype.length = previousLength;
			}
			expect(result).toBeUndefined();
			expect(observedCalls).toBe(0);
			expect(original.message.content).toBe("Synthetic port is 4317.");
		},
	);

	it.each(["array", "object"])("keeps dense data compatible under ordinary %s prototype index data", (kind) => {
		const prototype = kind === "array" ? Array.prototype : Object.prototype;
		const previousLength = Array.prototype.length;
		Object.defineProperty(prototype, "900", { value: null, configurable: true, writable: true });
		try {
			const current = snapshot(session);
			const parse = vi.spyOn(JSON, "parse");
			const hashes = vi.spyOn(identity, "hashEntries");
			expect(() => store.assertReady(session, current)).not.toThrow();
			expect(parse).toHaveBeenCalledTimes(3);
			expect(hashes).toHaveBeenCalledTimes(2);
		} finally {
			Reflect.deleteProperty(prototype, "900");
			if (kind === "array") Array.prototype.length = previousLength;
		}
	});

	it.each(["getter", "flags"])("requires the exact native __proto__ %s descriptor without invoking it", (kind) => {
		const native = Object.getOwnPropertyDescriptor(Object.prototype, "__proto__");
		if (!native || Object.hasOwn(native, "value")) throw new Error("Missing native accessor");
		const getter = vi.fn(() => Object.prototype);
		Object.defineProperty(
			Object.prototype,
			"__proto__",
			kind === "getter" ? { ...native, get: getter } : { ...native, enumerable: !native.enumerable },
		);
		let legacy: ReturnType<PreviewFailureStore["inspect"]>;
		let preflight: ReturnType<typeof createPreviewBranchSnapshot>;
		try {
			preflight = createPreviewBranchSnapshot(session.getBranch());
			legacy = new PreviewFailureStore(agentDir).inspect(session);
			const current = snapshot(session);
			const parse = vi.spyOn(JSON, "parse");
			const hashes = vi.spyOn(identity, "hashEntries");
			expect(() => store.assertReady(session, current)).not.toThrow();
			expect(parse).toHaveBeenCalledTimes(3);
			expect(hashes).toHaveBeenCalledTimes(2);
		} finally {
			Object.defineProperty(Object.prototype, "__proto__", native);
		}
		expect(preflight).toBeUndefined();
		expect(legacy).toEqual({ state: "ready" });
		expect(getter).not.toHaveBeenCalled();
	});

	it("keeps status and inspect on the original parser/hash path", () => {
		const hashes = vi.spyOn(identity, "hashEntries");
		const parse = vi.spyOn(JSON, "parse");
		expect(store.inspect(session)).toEqual({ state: "ready" });
		expect(existsSync(agentDir)).toBe(false);
		expect(parse).toHaveBeenCalledTimes(3);
		expect(hashes).toHaveBeenCalledTimes(2);
		parse.mockClear();
		hashes.mockClear();
		expect(store.status(session)).toEqual({ state: "ready" });
		expect(parse).toHaveBeenCalledTimes(3);
		expect(hashes).toHaveBeenCalledTimes(2);
	});

	it("parses sibling entries while the selected branch can still avoid both hashes", () => {
		const sibling = user("sibling", "source", "Synthetic sibling evidence.");
		session.persist([...session.entries, sibling]);
		const current = snapshot(session);
		const parse = vi.spyOn(JSON, "parse");
		const hashes = vi.spyOn(identity, "hashEntries");
		expect(() => store.assertReady(session, current)).not.toThrow();
		expect(parse).toHaveBeenCalledTimes(2);
		expect(hashes).not.toHaveBeenCalled();
	});

	it.each([false, true])(
		"advances through interleaved siblings after a selected whitespace line: %s",
		(whitespace) => {
			const source = user("source", null);
			const middle = user("middle", "source");
			const leaf = user("leaf", "middle");
			session.entries = [source, middle, leaf];
			session.persistLines([
				JSON.stringify(source),
				JSON.stringify(user("sibling-one", "source")),
				`${whitespace ? " \t" : ""}${JSON.stringify(middle)}`,
				JSON.stringify(user("sibling-two", "middle")),
				JSON.stringify(leaf),
			]);
			const current = snapshot(session);
			const parse = vi.spyOn(JSON, "parse");
			const hashes = vi.spyOn(identity, "hashEntries");
			expect(() => store.assertReady(session, current)).not.toThrow();
			expect(parse).toHaveBeenCalledTimes(whitespace ? 4 : 3);
			expect(hashes).toHaveBeenCalledTimes(whitespace ? 2 : 0);
		},
	);

	it.each(["中文 🔧 café", 'quoted " slash / tab\t newline\n', "\ud800", "\udfff", "𐐀 🧪"])(
		"compares canonical UTF8 bytes for Unicode and escaped source %j",
		(content) => {
			session.entries[0] = user("source", null, content);
			session.persist();
			expect(store.inspect(session)).toEqual({ state: "ready" });
			const current = snapshot(session);
			const parse = vi.spyOn(JSON, "parse");
			const hashes = vi.spyOn(identity, "hashEntries");
			expect(() => store.assertReady(session, current)).not.toThrow();
			expect(parse).toHaveBeenCalledTimes(1);
			expect(hashes).not.toHaveBeenCalled();
		},
	);

	it.each([[0xff], [0xc0, 0xaf], [0xe2, 0x82], [0x80, 0xbf]])(
		"preserves whole-file lossy UTF8 parsing for malformed bytes %j inside JSON strings",
		(...invalidBytes) => {
			const raw = Buffer.from(invalidBytes);
			const marker = "synthetic-byte-marker";
			const original = JSON.stringify(user("source", null, marker));
			const offset = original.indexOf(marker);
			const damaged = Buffer.concat([
				Buffer.from(original.slice(0, offset)),
				raw,
				Buffer.from(original.slice(offset + marker.length)),
			]);
			session.entries[0] = user("source", null, raw.toString("utf8"));
			const bytes = Buffer.concat([
				Buffer.from(`${JSON.stringify(session.header)}\n`),
				damaged,
				Buffer.from(`\n${JSON.stringify(session.entries[1])}\n`),
			]);
			writeFileSync(session.file, bytes);
			const legacyLines = bytes.toString("utf8").slice(0, -1).split("\n");
			const parse = vi.spyOn(JSON, "parse");
			expect(new PreviewFailureStore(agentDir).inspect(session)).toEqual({ state: "ready" });
			expect(parse.mock.calls.map(([line]) => line)).toEqual(legacyLines);
			parse.mockClear();
			const current = snapshot(session);
			const hashes = vi.spyOn(identity, "hashEntries");
			expect(() => store.assertReady(session, current)).not.toThrow();
			expect(parse.mock.calls.map(([line]) => line)).toEqual(legacyLines.slice(0, 2));
			expect(hashes).toHaveBeenCalledTimes(2);
		},
	);

	it("keeps malformed UTF8 immediately before LF on the original parser/error path", () => {
		const bytes = Buffer.concat([
			Buffer.from(`${JSON.stringify(session.header)}\n${JSON.stringify(session.entries[0])} `),
			Buffer.from([0xe2, 0x82]),
			Buffer.from(`\n${JSON.stringify(session.entries[1])}\n`),
		]);
		writeFileSync(session.file, bytes);
		const legacyLines = bytes.toString("utf8").slice(0, -1).split("\n");
		expect(() => JSON.parse(legacyLines[1])).toThrow();
		const current = snapshot(session);
		const parse = vi.spyOn(JSON, "parse");
		expect(new PreviewFailureStore(agentDir).inspect(session)).toEqual({
			state: "blocked",
			code: "CONTEXT_PREVIEW_SESSION_IO",
		});
		expect(parse.mock.calls.map(([line]) => line)).toEqual(legacyLines.slice(0, 2));
		parse.mockClear();
		expect(() => store.assertReady(session, current)).toThrow("CONTEXT_PREVIEW_SESSION_IO");
		expect(parse.mock.calls.map(([line]) => line)).toEqual(legacyLines.slice(0, 2));
	});

	it("retains CRLF whitespace compatibility and both original semantic hashes", () => {
		writeFileSync(session.file, readFileSync(session.file, "utf8").replaceAll("\n", "\r\n"));
		expect(store.inspect(session)).toEqual({ state: "ready" });
		const current = snapshot(session);
		const parse = vi.spyOn(JSON, "parse");
		const hashes = vi.spyOn(identity, "hashEntries");
		expect(() => store.assertReady(session, current)).not.toThrow();
		expect(parse).toHaveBeenCalledTimes(3);
		expect(hashes).toHaveBeenCalledTimes(2);
	});

	it.each(["BOM", "blank-record", "extra-final-LF", "missing-final-LF"])(
		"preserves legacy JSONL rejection for %s",
		(damage) => {
			const bytes = readFileSync(session.file);
			if (damage === "BOM") writeFileSync(session.file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]));
			if (damage === "blank-record") {
				const end = bytes.indexOf(10);
				writeFileSync(
					session.file,
					Buffer.concat([bytes.subarray(0, end + 1), Buffer.from("\n"), bytes.subarray(end + 1)]),
				);
			}
			if (damage === "extra-final-LF") writeFileSync(session.file, Buffer.concat([bytes, Buffer.from("\n")]));
			if (damage === "missing-final-LF") writeFileSync(session.file, bytes.subarray(0, -1));
			const code = damage === "missing-final-LF" ? "CONTEXT_PREVIEW_SESSION_INVALID" : "CONTEXT_PREVIEW_SESSION_IO";
			expect(new PreviewFailureStore(agentDir).inspect(session)).toEqual({ state: "blocked", code });
			expect(() => store.assertReady(session, snapshot(session))).toThrow(code);
		},
	);

	it.each([250_001, 250_002])("checks the %s physical-line limit before parsing even a malformed header", (lines) => {
		writeFileSync(session.file, `{${"\n".repeat(lines)}`);
		const current = snapshot(session);
		const parse = vi.spyOn(JSON, "parse");
		const overLimit = lines > 250_001;
		expect(() => store.assertReady(session, current)).toThrow(
			overLimit ? "CONTEXT_PREVIEW_SESSION_INVALID" : "CONTEXT_PREVIEW_SESSION_IO",
		);
		expect(parse).toHaveBeenCalledTimes(overLimit ? 0 : 1);
	});

	it("retains the bounded whole-file read contract before parsing or matching", () => {
		const current = snapshot(session);
		const actual = failureIo.readBoundedFile;
		const read = vi.spyOn(failureIo, "readBoundedFile");
		read.mockImplementation((file, limit, code) => {
			if (file === session.file) throw new failureIo.PreviewStoreError(code);
			return actual(file, limit, code);
		});
		const parse = vi.spyOn(JSON, "parse");
		expect(() => store.assertReady(session, current)).toThrow("CONTEXT_PREVIEW_SESSION_INVALID");
		expect(read.mock.calls.find(([file]) => file === session.file)).toEqual([
			session.file,
			64 * 1024 * 1024,
			"CONTEXT_PREVIEW_SESSION_INVALID",
		]);
		expect(parse).not.toHaveBeenCalled();
	});

	it.each(["malformed", "duplicate", "unknown-parent", "forward-parent", "second-root", "bad-timestamp"])(
		"checks the whole file and rejects off-branch %s corruption",
		(damage) => {
			const sibling = user("sibling", "source");
			if (damage === "malformed")
				session.persistLines([...session.entries.map((entry) => JSON.stringify(entry)), "{"]);
			if (damage === "duplicate") session.persist([...session.entries, { ...sibling, id: "source" }]);
			if (damage === "unknown-parent") session.persist([...session.entries, { ...sibling, parentId: "missing" }]);
			if (damage === "forward-parent")
				session.persist([...session.entries, { ...sibling, parentId: "later" }, user("later", "source")]);
			if (damage === "second-root") session.persist([...session.entries, { ...sibling, parentId: null }]);
			if (damage === "bad-timestamp") session.persist([...session.entries, { ...sibling, timestamp: 1 }]);
			expect(() => store.assertReady(session, snapshot(session))).toThrow(/CONTEXT_PREVIEW_SESSION_(INVALID|IO)/);
		},
	);

	it("rejects a repeated exact canonical line instead of treating it as a cache hit twice", () => {
		session.persist([...session.entries, session.entries[0]]);
		expect(() => store.assertReady(session, snapshot(session))).toThrow("CONTEXT_PREVIEW_SESSION_INVALID");
	});

	it("checks metadata even when the invalid entry itself has an exact canonical line", () => {
		const source = session.entries[0];
		source.timestamp = 1 as unknown as string;
		session.persist();
		expect(() => store.assertReady(session, snapshot(session))).toThrow("CONTEXT_PREVIEW_SESSION_INVALID");
	});

	it.each(["id", "type", "timestamp", "parentId"] as const)(
		"keeps a nonenumerable own %s field on the legacy parse path",
		(key) => {
			Object.defineProperty(session.entries[0], key, { enumerable: false });
			session.persist();
			expect(createPreviewBranchSnapshot(session.getBranch())).toBeUndefined();
			expect(new PreviewFailureStore(agentDir).inspect(session)).toEqual({
				state: "blocked",
				code: "CONTEXT_PREVIEW_SESSION_INVALID",
			});
			expect(() => store.assertReady(session, snapshot(session))).toThrow("CONTEXT_PREVIEW_SESSION_INVALID");
		},
	);

	it.each([NaN, Infinity, -Infinity])(
		"retains legacy acceptance when root parentId=%s serializes to null",
		(parentId) => {
			const source = user("source", null);
			source.parentId = parentId as unknown as null;
			session.entries = [source];
			session.leafId = source.id;
			session.persist();
			expect(createPreviewBranchSnapshot(session.getBranch())).toBeUndefined();
			expect(new PreviewFailureStore(agentDir).inspect(session)).toEqual({ state: "ready" });
			const current = snapshot(session);
			const parse = vi.spyOn(JSON, "parse");
			const hashes = vi.spyOn(identity, "hashEntries");
			expect(() => store.assertReady(session, current)).not.toThrow();
			expect(parse).toHaveBeenCalledTimes(2);
			expect(hashes).toHaveBeenCalledTimes(2);
		},
	);

	it.each(["id", "type", "timestamp", "parentId"] as const)(
		"preserves ordinary inherited %s metadata through legacy parsing",
		(key) => {
			const source = user("source", null);
			session.entries = [source];
			session.leafId = source.id;
			const value = source[key];
			Reflect.deleteProperty(source, key);
			Object.defineProperty(Object.prototype, key, { value, configurable: true, writable: true });
			let legacy: ReturnType<PreviewFailureStore["inspect"]>;
			let hinted: ReturnType<PreviewFailureStore["inspect"]>;
			let preflight: ReturnType<typeof createPreviewBranchSnapshot>;
			try {
				session.persist();
				preflight = createPreviewBranchSnapshot(session.getBranch());
				legacy = new PreviewFailureStore(agentDir).inspect(session);
				store.assertReady(session, snapshot(session));
				hinted = store.inspect(session);
			} finally {
				Reflect.deleteProperty(Object.prototype, key);
			}
			expect(preflight).toBeUndefined();
			expect(legacy).toEqual({ state: "ready" });
			expect(hinted).toEqual(legacy);
		},
	);

	it("does not let inherited metadata accessors distinguish borrowed objects from parsed objects", () => {
		const source = user("source", null);
		session.entries = [source];
		session.leafId = source.id;
		Reflect.deleteProperty(source, "timestamp");
		let calls = 0;
		Object.defineProperty(Object.prototype, "timestamp", {
			configurable: true,
			get(this: object) {
				calls++;
				return this === source ? timestamp : undefined;
			},
		});
		let legacy: ReturnType<PreviewFailureStore["inspect"]>;
		let hinted: ReturnType<PreviewFailureStore["inspect"]>;
		let preflight: ReturnType<typeof createPreviewBranchSnapshot>;
		let preflightCalls = -1;
		try {
			session.persist();
			preflight = createPreviewBranchSnapshot(session.getBranch());
			preflightCalls = calls;
			legacy = new PreviewFailureStore(agentDir).inspect(session);
			hinted = store.inspect(session);
			expect(() => store.assertReady(session, snapshot(session))).toThrow("CONTEXT_PREVIEW_SESSION_INVALID");
		} finally {
			Reflect.deleteProperty(Object.prototype, "timestamp");
		}
		expect(preflight).toBeUndefined();
		expect(preflightCalls).toBe(0);
		expect(legacy).toEqual({ state: "blocked", code: "CONTEXT_PREVIEW_SESSION_INVALID" });
		expect(hinted).toEqual(legacy);
	});

	it("retains parsed-object inheritance for null-prototype entries with omitted metadata", () => {
		const source = user("source", null);
		Object.setPrototypeOf(source, null);
		Reflect.deleteProperty(source, "timestamp");
		session.entries = [source];
		session.leafId = source.id;
		Object.defineProperty(Object.prototype, "timestamp", { value: timestamp, configurable: true, writable: true });
		let legacy: ReturnType<PreviewFailureStore["inspect"]>;
		let preflight: ReturnType<typeof createPreviewBranchSnapshot>;
		try {
			session.persist();
			preflight = createPreviewBranchSnapshot(session.getBranch());
			legacy = new PreviewFailureStore(agentDir).inspect(session);
			store.assertReady(session, snapshot(session));
		} finally {
			Reflect.deleteProperty(Object.prototype, "timestamp");
		}
		expect(preflight).toBeUndefined();
		expect(legacy).toEqual({ state: "ready" });
	});

	it("falls back to parsing and original semantic hashes for whitespace formatting", () => {
		session.persistLines(session.entries.map((entry) => `  ${JSON.stringify(entry)}\t `));
		const current = snapshot(session);
		const parse = vi.spyOn(JSON, "parse");
		const hashes = vi.spyOn(identity, "hashEntries");
		expect(() => store.assertReady(session, current)).not.toThrow();
		expect(parse).toHaveBeenCalledTimes(3);
		expect(hashes).toHaveBeenCalledTimes(2);
	});

	it("keeps the old hash semantics for reordered JSON fields rather than equating only values", () => {
		const entry = session.entries[0];
		const reordered = Object.fromEntries(Object.entries(entry).reverse());
		session.persist([reordered, session.entries[1]]);
		expect(new PreviewFailureStore(agentDir).inspect(session)).toMatchObject({ code: "CONTEXT_SOURCE_CHANGED" });
		expect(() => store.assertReady(session, snapshot(session))).toThrow("CONTEXT_SOURCE_CHANGED");
	});

	it("falls back for a mixed canonical/noncanonical branch without weakening equality", () => {
		session.persistLines([JSON.stringify(session.entries[0]), ` ${JSON.stringify(session.entries[1])}`]);
		const current = snapshot(session);
		const parse = vi.spyOn(JSON, "parse");
		const hashes = vi.spyOn(identity, "hashEntries");
		expect(() => store.assertReady(session, current)).not.toThrow();
		expect(parse).toHaveBeenCalledTimes(2);
		expect(hashes).toHaveBeenCalledTimes(2);
	});

	it("rejects disk tampering with the same IDs, leaf, byte length and file times", () => {
		store.assertReady(session, snapshot(session));
		const prior = statSync(session.file);
		const disk = structuredClone(session.entries);
		const first = disk[0];
		if (first.type !== "message" || first.message.role !== "user") throw new Error("Missing synthetic source");
		first.message.content = "Synthetic port is 4318.";
		session.persist(disk);
		utimesSync(session.file, prior.atime, prior.mtime);
		expect(statSync(session.file).size).toBe(prior.size);
		expect(() => store.assertReady(session, snapshot(session))).toThrow("CONTEXT_SOURCE_CHANGED");
	});

	it("rejects a same-object, same-leaf memory edit using this invocation's fresh serialization", () => {
		store.assertReady(session, snapshot(session));
		const original = session.entries[0];
		if (original.type !== "message" || original.message.role !== "user") throw new Error("Missing synthetic source");
		original.message.content = "Synthetic port is 4318.";
		expect(() => store.assertReady(session, snapshot(session))).toThrow("CONTEXT_SOURCE_CHANGED");
	});

	it("consumes a hint once so reuse cannot conceal a same-object memory edit", () => {
		const prior = snapshot(session);
		store.assertReady(session, prior);
		const original = session.entries[0];
		if (original.type !== "message" || original.message.role !== "user") throw new Error("Missing synthetic source");
		original.message.content = "Synthetic port is 4318.";
		expect(() => store.assertReady(session, prior)).toThrow("CONTEXT_SOURCE_CHANGED");
	});

	it("does not reuse a previously consumed hint even when its branch is unchanged", () => {
		const prior = snapshot(session);
		store.assertReady(session, prior);
		const parse = vi.spyOn(JSON, "parse");
		const hashes = vi.spyOn(identity, "hashEntries");
		expect(() => store.assertReady(session, prior)).not.toThrow();
		expect(parse).toHaveBeenCalledTimes(3);
		expect(hashes).toHaveBeenCalledTimes(2);
	});

	it("does not let a new snapshot wrapper turn already consumed bytes into authority", () => {
		const prior = snapshot(session);
		store.assertReady(session, prior);
		const original = session.entries[0];
		if (original.type !== "message" || original.message.role !== "user") throw new Error("Missing synthetic source");
		original.message.content = "Synthetic port is 4318.";
		const rewrapped = { branch: session.getBranch(), canonicalLines: prior.canonicalLines };
		expect(() => store.assertReady(session, rewrapped)).toThrow("CONTEXT_SOURCE_CHANGED");
	});

	it("does not let another store instance reuse an already consumed factory proof", () => {
		const prior = snapshot(session);
		store.assertReady(session, prior);
		const original = session.entries[0];
		if (original.type !== "message" || original.message.role !== "user") throw new Error("Missing synthetic source");
		original.message.content = "Synthetic port is 4318.";
		expect(() => new PreviewFailureStore(agentDir).assertReady(session, prior)).toThrow("CONTEXT_SOURCE_CHANGED");
	});

	it.each(["toJSON", "getter", "self-deleting-toJSON"])(
		"does not hide cross-entry edits caused by a later %s during serialization",
		(kind) => {
			const original = session.entries[0];
			const later = session.entries[1];
			if (original.type !== "message" || original.message.role !== "user" || later.type !== "message")
				throw new Error("Missing synthetic source");
			const originalMessage = original.message;
			const edit = () => {
				originalMessage.content = "Synthetic port is 4318.";
			};
			if (kind === "getter")
				Object.defineProperty(later.message, "content", {
					enumerable: true,
					get: () => {
						edit();
						return "Synthetic next instruction.";
					},
				});
			else
				Object.defineProperty(later, "toJSON", {
					configurable: true,
					value: () => {
						edit();
						if (kind === "self-deleting-toJSON") Reflect.deleteProperty(later, "toJSON");
						return { ...later };
					},
				});
			// The first entry's captured bytes precede the hook's edit to that same object.
			const current = snapshot(session);
			expect(new PreviewFailureStore(agentDir).inspect(session)).toMatchObject({
				state: "blocked",
				code: "CONTEXT_SOURCE_CHANGED",
			});
			expect(() => store.assertReady(session, current)).toThrow("CONTEXT_SOURCE_CHANGED");
		},
	);

	it.each(["array", "object"])(
		"does not hide cross-entry edits from a sparse array's inherited %s index getter",
		(kind) => {
			const original = session.entries[0];
			const later = session.entries[1];
			if (original.type !== "message" || original.message.role !== "user" || later.type !== "message")
				throw new Error("Missing synthetic source");
			const originalMessage = original.message;
			Object.defineProperty(later.message, "extra", { enumerable: true, value: new Array<unknown>(901) });
			session.persist();
			const prototype = kind === "array" ? Array.prototype : Object.prototype;
			const previousLength = Array.prototype.length;
			let calls = 0;
			Object.defineProperty(prototype, "900", {
				configurable: true,
				get() {
					calls++;
					originalMessage.content = "Synthetic port is 4318.";
					return null;
				},
				set(this: object, value: unknown) {
					Object.defineProperty(this, "900", { value, configurable: true, enumerable: true, writable: true });
				},
			});
			try {
				const branch = session.getBranch();
				const preflight = createPreviewBranchSnapshot(branch);
				expect(calls).toBe(0);
				// Explicitly run the same ordered serialization independently of hint eligibility.
				for (const [index, entry] of branch.entries()) {
					const serialized = JSON.stringify(entry);
					preflight?.onSerializedEntry(index, serialized);
				}
				expect(calls).toBeGreaterThan(0);
				expect(new PreviewFailureStore(agentDir).inspect(session)).toMatchObject({
					state: "blocked",
					code: "CONTEXT_SOURCE_CHANGED",
				});
				expect(() => store.assertReady(session, preflight?.snapshot)).toThrow("CONTEXT_SOURCE_CHANGED");
				expect(preflight).toBeUndefined();
			} finally {
				Reflect.deleteProperty(prototype, "900");
				if (kind === "array") Array.prototype.length = previousLength;
			}
		},
	);

	it("does not hide cross-entry edits from an intermediate Array prototype serializer", () => {
		const original = session.entries[0];
		const later = session.entries[1];
		if (original.type !== "message" || original.message.role !== "user" || later.type !== "message")
			throw new Error("Missing synthetic source");
		const originalMessage = original.message;
		Object.defineProperty(later.message, "extra", { enumerable: true, value: ["synthetic-array"] });
		session.persist();
		const previous: object | null = Object.getPrototypeOf(Array.prototype);
		const intermediate: object = Object.create(previous);
		Object.defineProperty(intermediate, "toJSON", {
			value(this: readonly unknown[]) {
				originalMessage.content = "Synthetic port is 4318.";
				return [...this];
			},
		});
		Object.setPrototypeOf(Array.prototype, intermediate);
		try {
			const current = snapshot(session);
			expect(new PreviewFailureStore(agentDir).inspect(session)).toEqual({
				state: "blocked",
				code: "CONTEXT_SOURCE_CHANGED",
			});
			expect(() => store.assertReady(session, current)).toThrow("CONTEXT_SOURCE_CHANGED");
		} finally {
			Object.setPrototypeOf(Array.prototype, previous);
		}
	});

	it("rejects an intermediate Array prototype before its inherited serializer getter runs", () => {
		const previous: object | null = Object.getPrototypeOf(Array.prototype);
		const intermediate: object = Object.create(previous);
		const getter = vi.fn(() => {
			throw new Error("Synthetic inherited serializer must stay unobserved during preflight");
		});
		Object.defineProperty(intermediate, "toJSON", { get: getter });
		Object.setPrototypeOf(Array.prototype, intermediate);
		let result: ReturnType<typeof createPreviewBranchSnapshot>;
		try {
			result = createPreviewBranchSnapshot(session.getBranch());
		} finally {
			Object.setPrototypeOf(Array.prototype, previous);
		}
		expect(result).toBeUndefined();
		expect(getter).not.toHaveBeenCalled();
	});

	it.each(["quote-getter", "schema-container"])(
		"does not let an inherited %s mutate captured sources during checkpoint validation",
		(kind) => {
			const original = session.entries[0];
			if (original.type !== "message" || original.message.role !== "user")
				throw new Error("Missing synthetic source");
			const originalMessage = original.message;
			const note: MemoryNote = {
				instructions: [],
				failedPaths: [],
				reasons: [],
				state: [{ text: "Synthetic retained state.", sources: [original.id] }],
				nextSteps: [],
				files: [],
				gaps: [],
			};
			const checkpoint: SessionEntry = {
				type: "compaction",
				id: "checkpoint",
				parentId: original.id,
				timestamp,
				summary: renderNote(note),
				firstKeptEntryId: identity.CONTEXT_KEEP_NONE,
				tokensBefore: 100,
				details: {
					kind: identity.CONTEXT_MEMORY_KIND,
					version: identity.CONTEXT_MEMORY_VERSION,
					note,
					coveredThrough: original.id,
					sourceHash: identity.hashEntries([original]),
					snapshot: { sessionId: session.getSessionId(), leafId: original.id, lastCheckpointId: null },
					writerModel: "synthetic/readback",
					chunkCount: 1,
					build: "stock-preview-synthetic",
				},
			};
			session.entries = [original, checkpoint];
			session.leafId = checkpoint.id;
			session.persist();
			let calls = 0;
			const mutate = () => {
				calls++;
				originalMessage.content = "Synthetic port is 4318.";
			};
			const key = kind === "quote-getter" ? "quote" : "if";
			if (kind === "quote-getter")
				Object.defineProperty(Object.prototype, key, {
					configurable: true,
					get() {
						mutate();
						return undefined;
					},
				});
			else {
				const container: object = Object.create(null);
				Object.defineProperty(container, "type", {
					enumerable: true,
					get() {
						mutate();
						return "null";
					},
				});
				Object.defineProperty(Object.prototype, key, { configurable: true, value: container });
			}
			try {
				const branch = session.getBranch();
				const collector = createPreviewBranchSnapshot(branch);
				expect(calls).toBe(0);
				// The shared validator captures prefix bytes before reading inherited schema/fact properties.
				expect(validateMemoryCheckpoints(branch, collector?.onSerializedEntry)?.entry.id).toBe(checkpoint.id);
				expect(calls).toBeGreaterThan(0);
				expect(originalMessage.content).toBe("Synthetic port is 4318.");
				expect(new PreviewFailureStore(agentDir).inspect(session)).toEqual({
					state: "blocked",
					code: "CONTEXT_SOURCE_CHANGED",
				});
				expect(() => store.assertReady(session, collector?.snapshot)).toThrow("CONTEXT_SOURCE_CHANGED");
			} finally {
				Reflect.deleteProperty(Object.prototype, key);
			}
		},
	);

	it("judges an entry ID changed by toJSON from the disk JSON, as the ordinary path does", () => {
		const original = session.entries[0];
		Object.defineProperty(original, "toJSON", { value: () => user("different-id", null), configurable: true });
		session.persist();
		expect(new PreviewFailureStore(agentDir).inspect(session)).toMatchObject({
			state: "blocked",
			code: "CONTEXT_PREVIEW_SESSION_INVALID",
		});
		expect(() => store.assertReady(session, snapshot(session))).toThrow("CONTEXT_PREVIEW_SESSION_INVALID");
	});

	it("preserves legacy acceptance when toJSON normalizes invalid in-memory metadata", () => {
		const original = session.entries[0];
		original.timestamp = 1 as unknown as string;
		Object.defineProperty(original, "toJSON", { value: () => ({ ...original, timestamp }), configurable: true });
		session.persist();
		expect(new PreviewFailureStore(agentDir).inspect(session)).toEqual({ state: "ready" });
		const current = snapshot(session);
		const parse = vi.spyOn(JSON, "parse");
		const hashes = vi.spyOn(identity, "hashEntries");
		expect(() => store.assertReady(session, current)).not.toThrow();
		expect(parse).toHaveBeenCalledTimes(3);
		expect(hashes).toHaveBeenCalledTimes(2);
	});

	it("does not trust inherited toJSON even on otherwise ordinary entry objects", () => {
		Object.defineProperty(Object.prototype, "toJSON", {
			configurable: true,
			value(this: Record<string, unknown>) {
				return this.type === "message" && this.id === "source" ? { ...this, id: "different-id" } : this;
			},
		});
		try {
			session.persist();
			expect(new PreviewFailureStore(agentDir).inspect(session)).toMatchObject({
				state: "blocked",
				code: "CONTEXT_PREVIEW_SESSION_INVALID",
			});
			expect(() => store.assertReady(session, snapshot(session))).toThrow("CONTEXT_PREVIEW_SESSION_INVALID");
		} finally {
			Reflect.deleteProperty(Object.prototype, "toJSON");
		}
	});

	it.each(["getter", "proxy", "custom-prototype", "date", "function"])(
		"uses ordinary parsing and hash equality for a %s payload without rejecting old compatible input",
		(kind) => {
			const original = session.entries[0];
			if (original.type !== "message" || original.message.role !== "user")
				throw new Error("Missing synthetic source");
			if (kind === "getter")
				Object.defineProperty(original.message, "content", {
					enumerable: true,
					get: () => "Synthetic port is 4317.",
				});
			if (kind === "proxy") original.message = new Proxy(original.message, {});
			if (kind === "custom-prototype") Object.setPrototypeOf(original.message, {});
			if (kind === "date")
				Object.defineProperty(original.message, "extra", { enumerable: true, value: new Date(timestamp) });
			if (kind === "function")
				Object.defineProperty(original.message, "extra", { enumerable: true, value: () => 1 });
			session.persist();
			expect(new PreviewFailureStore(agentDir).inspect(session)).toEqual({ state: "ready" });
			const current = snapshot(session);
			const parse = vi.spyOn(JSON, "parse");
			const hashes = vi.spyOn(identity, "hashEntries");
			expect(() => store.assertReady(session, current)).not.toThrow();
			expect(parse).toHaveBeenCalledTimes(3);
			expect(hashes).toHaveBeenCalledTimes(2);
		},
	);

	it("inspects accessor descriptors without invoking an otherwise unobserved getter", () => {
		const getter = vi.fn(() => {
			throw new Error("Synthetic getter must stay unobserved");
		});
		Object.defineProperty(session.entries[0], "ignored", { get: getter, enumerable: false });
		session.persist();
		const current = snapshot(session);
		const parse = vi.spyOn(JSON, "parse");
		expect(() => store.assertReady(session, current)).not.toThrow();
		expect(parse).toHaveBeenCalledTimes(3);
		expect(getter).not.toHaveBeenCalled();
	});

	it("keeps plain arrays and optional undefined payload values on the exact-line path", () => {
		const extra: SessionEntry = {
			type: "custom",
			id: "custom-leaf",
			parentId: "leaf",
			timestamp,
			customType: "synthetic-readback",
			data: { optional: undefined, values: [undefined, "synthetic", 1, null, true] },
		};
		session.entries.push(extra);
		session.leafId = extra.id;
		session.persist();
		const current = snapshot(session);
		const parse = vi.spyOn(JSON, "parse");
		const hashes = vi.spyOn(identity, "hashEntries");
		expect(() => store.assertReady(session, current)).not.toThrow();
		expect(parse).toHaveBeenCalledTimes(1);
		expect(hashes).not.toHaveBeenCalled();
	});

	it("keeps nested nonfinite and hidden ordinary payload data on the exact-line path", () => {
		const extra: SessionEntry = {
			type: "custom",
			id: "custom-leaf",
			parentId: "leaf",
			timestamp,
			customType: "synthetic-readback",
			data: { optional: undefined, values: [NaN, Infinity, -Infinity, -0, undefined] },
		};
		Object.defineProperty(extra, "ignored", { value: "synthetic hidden data" });
		session.entries.push(extra);
		session.leafId = extra.id;
		session.persist();
		expect(store.inspect(session)).toEqual({ state: "ready" });
		const current = snapshot(session);
		const parse = vi.spyOn(JSON, "parse");
		const hashes = vi.spyOn(identity, "hashEntries");
		expect(() => store.assertReady(session, current)).not.toThrow();
		expect(parse).toHaveBeenCalledTimes(1);
		expect(hashes).not.toHaveBeenCalled();
	});

	it("rejects unmatched disk headers and truncated or missing JSONL despite a complete hint", () => {
		const current = snapshot(session);
		const lines = readFileSync(session.file, "utf8").split("\n");
		lines[0] = JSON.stringify({ ...session.header, id: "different-session" });
		writeFileSync(session.file, lines.join("\n"));
		expect(() => store.assertReady(session, current)).toThrow("CONTEXT_PREVIEW_SESSION_INVALID");
		session.persist();
		writeFileSync(session.file, readFileSync(session.file, "utf8").trimEnd());
		expect(() => new PreviewFailureStore(agentDir).assertReady(session, snapshot(session))).toThrow(
			"CONTEXT_PREVIEW_SESSION_INVALID",
		);
		rmSync(session.file);
		expect(() => new PreviewFailureStore(agentDir).assertReady(session, snapshot(session))).toThrow(
			"CONTEXT_PREVIEW_SESSION_IO",
		);
	});

	it("ignores a hint when branch objects change, including unchanged IDs and leaf", () => {
		const prior = snapshot(session);
		session.entries = structuredClone(session.entries);
		const first = session.entries[0];
		if (first.type !== "message" || first.message.role !== "user") throw new Error("Missing synthetic source");
		first.message.content = "Synthetic port is 4318.";
		expect(() => store.assertReady(session, prior)).toThrow("CONTEXT_SOURCE_CHANGED");
	});

	it("ignores a hint when the leaf moves and parses the newly selected branch normally", () => {
		const prior = snapshot(session);
		session.entries.push(user("later-leaf", "leaf"));
		session.leafId = "later-leaf";
		session.persist();
		const parse = vi.spyOn(JSON, "parse");
		const hashes = vi.spyOn(identity, "hashEntries");
		expect(() => store.assertReady(session, prior)).not.toThrow();
		expect(parse).toHaveBeenCalledTimes(4);
		expect(hashes).toHaveBeenCalledTimes(2);
	});

	it("preserves pending and blocked marker gates before any canonical readback", () => {
		store.begin(session);
		expect(() => store.assertReady(session, snapshot(session))).toThrow("CONTEXT_PREVIEW_PENDING");
		store.fail(session, "CONTEXT_WRITER_FAILED");
		expect(() => store.assertReady(session, snapshot(session))).toThrow("CONTEXT_WRITER_FAILED");
	});

	it.each(["symlink", "hardlink"])("still rejects %s session files before using the hint", (kind) => {
		const target = join(root, "synthetic-target.jsonl");
		writeFileSync(target, readFileSync(session.file));
		rmSync(session.file);
		if (kind === "symlink") symlinkSync(target, session.file);
		else linkSync(target, session.file);
		expect(() => store.assertReady(session, snapshot(session))).toThrow("CONTEXT_PREVIEW_SESSION_INVALID");
	});

	it("supports an empty unflushed session without inventing a file or checkpoint", () => {
		session.entries = [];
		session.leafId = null;
		rmSync(session.file);
		expect(() => store.assertReady(session, snapshot(session))).not.toThrow();
		expect(existsSync(session.file)).toBe(false);
		expect(store.markerPresent(session)).toBe(false);
	});

	it("keeps malformed markers blocking even with exact current lines", () => {
		mkdirSync(join(agentDir, "context-memory-preview", "failures"), { recursive: true });
		const markerHash = createHash("sha256").update(session.getSessionId()).digest("hex");
		writeFileSync(join(agentDir, "context-memory-preview", "failures", `${markerHash}.json`), "{");
		expect(() => store.assertReady(session, snapshot(session))).toThrow("CONTEXT_PREVIEW_MARKER_INVALID");
	});

	it("keeps session read errors blocking even with exact current lines", () => {
		const actual = failureIo.readBoundedFile;
		const read = vi.spyOn(failureIo, "readBoundedFile");
		read.mockImplementation((file, limit, code) => {
			if (file === session.file) throw new failureIo.PreviewStoreError("CONTEXT_PREVIEW_SESSION_IO");
			return actual(file, limit, code);
		});
		expect(() => store.assertReady(session, snapshot(session))).toThrow("CONTEXT_PREVIEW_SESSION_IO");
	});
});

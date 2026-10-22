import { createHash } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildSessionProjection,
	type ExtensionContext,
	type SessionEntry,
	type SessionHeader,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// The preview's validation walk now lives in the core copy (v0.7.0 WP2 step 3); the spies must target it.
import * as notes from "../../compaction-core/src/notes.ts";
import { DEFAULT_MEMORY_CONFIG } from "../src/extensions/context-memory/config.ts";
import type { PreviewSession } from "../src/extensions/context-memory/preview/contracts.ts";
import { PreviewMemoryController } from "../src/extensions/context-memory/preview/controller.ts";
import * as failureIo from "../src/extensions/context-memory/preview/failure-io.ts";
import { PreviewFailureStore } from "../src/extensions/context-memory/preview/failure-store.ts";

const timestamp = "2026-01-01T00:00:00.000Z";

function user(id: string, parentId: string | null, content = "Synthetic port is 4317."): SessionEntry {
	return { type: "message", id, parentId, timestamp, message: { role: "user", content, timestamp: 1 } };
}

/** Writes the way stock Pi 1.1.0 does: memory first, then one appended JSON line per entry. */
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
		writeFileSync(this.file, `${[this.header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	}
	/** `written: false` models an append whose disk write failed after Pi had published the entry. */
	append(entry: SessionEntry, written = true): void {
		this.entries.push(entry);
		this.leafId = entry.id;
		if (written) appendFileSync(this.file, `${JSON.stringify(entry)}\n`);
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

/** Same bytes and inode, different content: what only a full readback can see. */
function rewriteFirstSourceInPlace(session: ReadbackSession): void {
	const disk = structuredClone(session.entries);
	const first = disk[0];
	if (first.type !== "message" || first.message.role !== "user") throw new Error("Missing synthetic source");
	first.message.content = "Synthetic port is 4318.";
	const before = statSync(session.file);
	session.persist(disk);
	const after = statSync(session.file);
	expect([after.ino, after.size]).toEqual([before.ino, before.size]);
}

describe("preview request readback: full at trust boundaries, length check between them", () => {
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
	function sessionReads(read: { mock: { calls: readonly (readonly unknown[])[] } }): number {
		return read.mock.calls.filter(([file]) => file === session.file).length;
	}

	it("reads the session once, then follows Pi's appends by length without reading it again", () => {
		const read = vi.spyOn(failureIo, "readBoundedFile");
		store.assertReady(session);
		store.assertReady(session);
		session.append(user("next", "leaf", "Synthetic follow-up with multibyte text: 端口 4317."));
		store.assertReady(session);
		expect(sessionReads(read)).toBe(1);
		expect(store.markerPresent(session)).toBe(false);
	});

	it("reads the whole file again after forgetReadback", () => {
		const read = vi.spyOn(failureIo, "readBoundedFile");
		store.assertReady(session);
		store.forgetReadback();
		store.assertReady(session);
		expect(sessionReads(read)).toBe(2);
	});

	it("shares one fresh read between implicit begin and its readiness check", () => {
		const read = vi.spyOn(failureIo, "readBoundedFile");
		store.begin(session);
		expect(sessionReads(read)).toBe(1);
		expect(store.status(session).state).toBe("pending");
	});

	it.each(["memory", "disk"])("begin refuses a same-leaf %s edit after an earlier readback", (location) => {
		store.assertReady(session);
		if (location === "disk") rewriteFirstSourceInPlace(session);
		else {
			const first = session.entries[0];
			if (first.type !== "message" || first.message.role !== "user") throw new Error("Missing source");
			first.message.content = "Synthetic port is 4318.";
		}
		const read = vi.spyOn(failureIo, "readBoundedFile");
		expect(() => store.begin(session)).toThrow("CONTEXT_SOURCE_CHANGED");
		expect(sessionReads(read)).toBe(1);
	});

	it("finds an append that reached memory but not disk at the next request", () => {
		store.assertReady(session);
		session.append(user("lost", "leaf"), false);
		expect(() => store.assertReady(session)).toThrow("CONTEXT_PREVIEW_SESSION_INVALID");
	});

	it("re-reads after a foreign append and stays ready when the branch is unchanged", () => {
		const read = vi.spyOn(failureIo, "readBoundedFile");
		store.assertReady(session);
		appendFileSync(session.file, `${JSON.stringify(user("other-writer", "source"))}\n`);
		store.assertReady(session);
		store.assertReady(session);
		expect(sessionReads(read)).toBe(2);
	});

	it("finds truncation at the next request", () => {
		store.assertReady(session);
		const lines = readFileSync(session.file, "utf8").trimEnd().split("\n");
		writeFileSync(session.file, `${lines.slice(0, -1).join("\n")}\n`);
		expect(() => store.assertReady(session)).toThrow("CONTEXT_PREVIEW_SESSION_INVALID");
	});

	it("finds a same-length replacement file through its new inode", () => {
		store.assertReady(session);
		const before = statSync(session.file);
		const temporary = join(root, "replacement.jsonl");
		writeFileSync(temporary, readFileSync(session.file, "utf8").replace("port is 4317.", "port is 4318."));
		renameSync(temporary, session.file);
		const after = statSync(session.file);
		expect(after.size).toBe(before.size);
		expect(after.ino).not.toBe(before.ino);
		expect(() => store.assertReady(session)).toThrow("CONTEXT_SOURCE_CHANGED");
	});

	it("reads a symlink swapped in after a full readback, and rejects it", () => {
		store.assertReady(session);
		const target = join(root, "synthetic-target.jsonl");
		writeFileSync(target, readFileSync(session.file));
		rmSync(session.file);
		symlinkSync(target, session.file);
		expect(() => store.assertReady(session)).toThrow("CONTEXT_PREVIEW_SESSION_INVALID");
	});

	it("leaves a same-length in-place rewrite to the next trust boundary, where it blocks", () => {
		store.assertReady(session);
		rewriteFirstSourceInPlace(session);
		expect(() => store.assertReady(session)).not.toThrow();
		expect(() => store.begin(session)).toThrow("CONTEXT_SOURCE_CHANGED");
		expect(store.status(session)).toEqual({ state: "blocked", code: "CONTEXT_SOURCE_CHANGED" });
	});

	it("leaves an in-place memory edit to the next trust boundary, where it blocks", () => {
		store.assertReady(session);
		const original = session.entries[0];
		if (original.type !== "message" || original.message.role !== "user") throw new Error("Missing synthetic source");
		original.message.content = "Synthetic port is 4318.";
		expect(() => store.assertReady(session)).not.toThrow();
		store.forgetReadback();
		expect(() => store.assertReady(session)).toThrow("CONTEXT_SOURCE_CHANGED");
	});

	it("keeps pending and blocked markers blocking on every request", () => {
		store.assertReady(session);
		store.begin(session);
		expect(() => store.assertReady(session)).toThrow("CONTEXT_PREVIEW_PENDING");
		store.fail(session, "CONTEXT_WRITER_FAILED");
		expect(() => store.assertReady(session)).toThrow("CONTEXT_WRITER_FAILED");
	});

	it("keeps a malformed marker blocking after a full readback", () => {
		store.assertReady(session);
		mkdirSync(join(agentDir, "context-memory-preview", "failures"), { recursive: true });
		const markerHash = createHash("sha256").update(session.getSessionId()).digest("hex");
		writeFileSync(join(agentDir, "context-memory-preview", "failures", `${markerHash}.json`), "{");
		expect(() => store.assertReady(session)).toThrow("CONTEXT_PREVIEW_MARKER_INVALID");
	});

	it.each(["symlink", "hardlink"])("rejects %s session files on a full readback", (kind) => {
		const target = join(root, "synthetic-target.jsonl");
		writeFileSync(target, readFileSync(session.file));
		rmSync(session.file);
		if (kind === "symlink") symlinkSync(target, session.file);
		else linkSync(target, session.file);
		expect(() => store.assertReady(session)).toThrow("CONTEXT_PREVIEW_SESSION_INVALID");
	});

	it("rejects unmatched headers and truncated or missing JSONL", () => {
		const lines = readFileSync(session.file, "utf8").split("\n");
		lines[0] = JSON.stringify({ ...session.header, id: "different-session" });
		writeFileSync(session.file, lines.join("\n"));
		expect(() => store.assertReady(session)).toThrow("CONTEXT_PREVIEW_SESSION_INVALID");
		session.persist();
		writeFileSync(session.file, readFileSync(session.file, "utf8").trimEnd());
		expect(() => new PreviewFailureStore(agentDir).assertReady(session)).toThrow("CONTEXT_PREVIEW_SESSION_INVALID");
		rmSync(session.file);
		expect(() => new PreviewFailureStore(agentDir).assertReady(session)).toThrow("CONTEXT_PREVIEW_SESSION_IO");
	});

	it("supports an empty unflushed session without inventing a file or checkpoint", () => {
		session.entries = [];
		session.leafId = null;
		rmSync(session.file);
		expect(() => store.assertReady(session)).not.toThrow();
		expect(() => store.assertReady(session)).not.toThrow();
		expect(existsSync(session.file)).toBe(false);
		expect(store.markerPresent(session)).toBe(false);
	});

	it("keeps session read errors blocking", () => {
		const actual = failureIo.readBoundedFile;
		vi.spyOn(failureIo, "readBoundedFile").mockImplementation((file, limit, code) => {
			if (file === session.file) throw new failureIo.PreviewStoreError("CONTEXT_PREVIEW_SESSION_IO");
			return actual(file, limit, code);
		});
		expect(() => store.assertReady(session)).toThrow("CONTEXT_PREVIEW_SESSION_IO");
	});
});

describe("preview request validation: full at trust boundaries, new entries between them", () => {
	let root: string;
	let session: ReadbackSession;
	let controller: PreviewMemoryController;
	let ctx: ExtensionContext;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-preview-validation-"));
		session = new ReadbackSession(root);
		controller = new PreviewMemoryController({
			config: DEFAULT_MEMORY_CONFIG,
			failureStore: new PreviewFailureStore(join(root, "agent")),
		});
		ctx = { sessionManager: session } as unknown as ExtensionContext;
	});
	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(root, { recursive: true, force: true });
	});

	it("validates sources once, then checks only the entries added since", () => {
		const validate = vi.spyOn(notes, "validateMemoryCheckpoints");
		controller.assertReady(ctx);
		controller.assertReady(ctx);
		session.append(user("next", "leaf"));
		controller.assertReady(ctx);
		expect(validate).toHaveBeenCalledTimes(1);
	});

	it("serializes the in-memory branch once for validation and readiness", () => {
		const stringify = vi.spyOn(JSON, "stringify");
		controller.assertReady(ctx);
		for (const entry of session.entries) {
			expect(stringify.mock.calls.filter(([value]) => value === entry)).toHaveLength(1);
		}
	});

	it("compares canonical bytes even when the disk JSON has different spacing", () => {
		writeFileSync(
			session.file,
			`${[session.header, ...session.entries].map((entry) => JSON.stringify(entry).replaceAll('":', '": ')).join("\n")}\n`,
		);
		expect(() => controller.assertReady(ctx)).not.toThrow();
	});

	it.each(["memory", "disk"])("shared validation bytes still refuse an in-place %s edit", (location) => {
		controller.assertReady(ctx);
		if (location === "disk") rewriteFirstSourceInPlace(session);
		else {
			const first = session.entries[0];
			if (first.type !== "message" || first.message.role !== "user") throw new Error("Missing source");
			first.message.content = "Synthetic port is 4318.";
		}
		controller.branchChanged(ctx);
		expect(() => controller.assertReady(ctx)).toThrow("CONTEXT_SOURCE_CHANGED");
	});

	it("validates the newly selected branch in full after a branch switch", () => {
		session.append(user("left", "leaf"));
		const validate = vi.spyOn(notes, "validateMemoryCheckpoints");
		controller.assertReady(ctx);
		session.append(user("right", "leaf"));
		controller.assertReady(ctx);
		expect(validate).toHaveBeenCalledTimes(2);
	});

	it("validates in full after tree navigation that extends the previous branch", () => {
		const validate = vi.spyOn(notes, "validateMemoryCheckpoints");
		controller.assertReady(ctx);
		session.append(user("descendant", "leaf"));
		controller.branchChanged(ctx);
		controller.assertReady(ctx);
		expect(validate).toHaveBeenCalledTimes(2);
	});

	it("routes unsupported new content to the full validation and its error", () => {
		controller.assertReady(ctx);
		session.append({
			type: "message",
			id: "image",
			parentId: "leaf",
			timestamp,
			message: { role: "user", content: [{ type: "image", data: "AA==", mimeType: "image/png" }], timestamp: 1 },
		});
		expect(() => controller.assertReady(ctx)).toThrow("CONTEXT_PREVIEW_UNSUPPORTED");
	});

	it("validates in full again after a recorded failure", () => {
		const validate = vi.spyOn(notes, "validateMemoryCheckpoints");
		controller.assertReady(ctx);
		controller.fail(ctx, "CONTEXT_WRITER_FAILED");
		expect(() => controller.assertReady(ctx)).toThrow("CONTEXT_WRITER_FAILED");
		expect(validate).toHaveBeenCalledTimes(2);
	});
});

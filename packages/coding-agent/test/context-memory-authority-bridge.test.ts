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
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UserMessage } from "@earendil-works/pi-ai";
import { buildSessionProjection, type SessionEntry, type SessionHeader } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	AUTHORITY_CLAIM_TYPE,
	AUTHORITY_PROTOCOL_PREFIX,
	AUTHORITY_SEAL_TYPE,
	type AuthorityBridgeAction,
	type AuthorityEnrollment,
	authoritySourceHash,
	PreviewAuthorityBridge,
} from "../src/extensions/context-memory/preview/authority-bridge.ts";
import type { PreviewSession } from "../src/extensions/context-memory/preview/contracts.ts";
import * as failureIo from "../src/extensions/context-memory/preview/failure-io.ts";
import { PreviewFailureStore } from "../src/extensions/context-memory/preview/failure-store.ts";

const timestamp = "2026-01-01T00:00:00.000Z";
const reviewed: UserMessage = {
	role: "user",
	content: [{ type: "text", text: "Synthetic reviewed directive." }],
	timestamp: 1,
};
const actions: AuthorityBridgeAction[] = ["dispatch", "compact", "retry", "recover", "navigate", "fork"];

/** Synthetic public-manager shape; actual official SDK setup is tested separately. */
class BridgeSession implements PreviewSession {
	header: SessionHeader;
	readonly root: string;
	readonly file: string;
	entries: SessionEntry[] = [];
	leafId: string | null = null;
	constructor(root: string, name = "synthetic-session") {
		this.root = root;
		this.file = join(root, `${name}.jsonl`);
		this.header = { type: "session", version: 3, id: name, timestamp, cwd: root };
	}
	append(entry: Omit<SessionEntry, "id" | "parentId" | "timestamp">): string {
		const id = `entry-${this.entries.length + 1}`;
		this.entries.push({ ...entry, id, parentId: this.leafId, timestamp } as SessionEntry);
		this.leafId = id;
		if (existsSync(this.file)) this.persist();
		return id;
	}
	appendCustom(customType: string, data: unknown): string {
		const id = `entry-${this.entries.length + 1}`;
		this.entries.push({ type: "custom", id, parentId: this.leafId, timestamp, customType, data });
		this.leafId = id;
		if (existsSync(this.file)) this.persist();
		return id;
	}
	appendSource(message: UserMessage = reviewed): string {
		const id = `entry-${this.entries.length + 1}`;
		this.entries.push({ type: "message", id, parentId: this.leafId, timestamp, message: structuredClone(message) });
		this.leafId = id;
		this.persist();
		return id;
	}
	thinking(): void {
		const id = `entry-${this.entries.length + 1}`;
		this.entries.push({ type: "thinking_level_change", id, parentId: this.leafId, timestamp, thinkingLevel: "off" });
		this.leafId = id;
	}
	model(): void {
		const id = `entry-${this.entries.length + 1}`;
		this.entries.push({
			type: "model_change",
			id,
			parentId: this.leafId,
			timestamp,
			provider: "synthetic",
			modelId: "synthetic-model",
		});
		this.leafId = id;
	}
	persist(): void {
		writeFileSync(this.file, `${[this.header, ...this.entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	}
	reopen(): BridgeSession {
		const reopened = new BridgeSession(this.root, this.header.id);
		if (!existsSync(this.file)) {
			reopened.header = structuredClone(this.header);
			return reopened;
		}
		const [header, ...entries] = readFileSync(this.file, "utf8")
			.trimEnd()
			.split("\n")
			.flatMap((line) => {
				try {
					return [JSON.parse(line) as unknown];
				} catch {
					return [];
				}
			});
		reopened.header = header as SessionHeader;
		reopened.entries = entries as SessionEntry[];
		reopened.leafId = reopened.entries.at(-1)?.id ?? null;
		return reopened;
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
		const branch: SessionEntry[] = [];
		let current = this.getEntry(fromId ?? this.leafId ?? "");
		const visited = new Set<string>();
		while (current && !visited.has(current.id)) {
			visited.add(current.id);
			branch.unshift(current);
			current = this.getEntry(current.parentId ?? "");
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

describe("authority ownership bridge: bounded OFF-by-default primitive", () => {
	let root: string;
	let agentDir: string;
	let session: BridgeSession;
	let bridge: PreviewAuthorityBridge;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-authority-bridge-"));
		agentDir = join(root, "agent");
		session = new BridgeSession(root);
		bridge = new PreviewAuthorityBridge(agentDir, { enabled: true });
	});
	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(root, { recursive: true, force: true });
	});
	function barrierFile(): string {
		const hash = createHash("sha256").update(session.file).digest("hex");
		return join(agentDir, "context-memory-preview", "authority", `${hash}.json`);
	}
	function begin(): AuthorityEnrollment {
		return bridge.beginEnrollment(session, authoritySourceHash(reviewed));
	}
	function source(): AuthorityEnrollment {
		const token = begin();
		session.appendCustom(token.customType, token.data);
		session.appendSource();
		bridge.confirmSource(session, token);
		return token;
	}
	function active(): AuthorityEnrollment {
		const token = source();
		const seal = bridge.createSealClaim(session, token);
		const sealId = session.appendCustom(seal.customType, seal.data);
		bridge.confirmSeal(session, token, sealId);
		return token;
	}
	function refused(reader = bridge, current = session): void {
		for (const action of actions) expect(() => reader.assertLegacy(current, action)).toThrow(/CONTEXT_AUTHORITY_/);
	}

	it("leaves valid legacy sessions readable and creates no ownership files", () => {
		session.thinking();
		session.appendSource();
		const bytes = readFileSync(session.file);
		const reader = new PreviewAuthorityBridge(agentDir);
		expect(reader.inspect(session)).toEqual({ state: "legacy", owned: false });
		for (const action of actions) expect(() => reader.assertLegacy(session, action)).not.toThrow();
		expect(existsSync(agentDir)).toBe(false);
		expect(readFileSync(session.file)).toEqual(bytes);
	});
	it("keeps source-only legacy trees readable after a stock-style leaf reset", () => {
		session.appendSource();
		session.leafId = null;
		session.appendSource();
		const bytes = readFileSync(session.file);
		const reader = new PreviewAuthorityBridge(agentDir);
		expect(reader.inspect(session)).toEqual({ state: "legacy", owned: false });
		for (const action of actions) expect(() => reader.assertLegacy(session, action)).not.toThrow();
		expect(existsSync(agentDir)).toBe(false);
		expect(readFileSync(session.file)).toEqual(bytes);
	});
	it("recognizes legacy session identifiers containing a stock-supported period", () => {
		session = new BridgeSession(root, "synthetic.legacy");
		session.appendSource();
		expect(bridge.inspect(session)).toEqual({ state: "legacy", owned: false });
		for (const action of actions) expect(() => bridge.assertLegacy(session, action)).not.toThrow();
		expect(existsSync(agentDir)).toBe(false);
	});
	it("keeps enrollment OFF by default without making a legacy claim", () => {
		const reader = new PreviewAuthorityBridge(agentDir);
		expect(() => reader.beginEnrollment(session, authoritySourceHash(reviewed))).toThrow(
			"CONTEXT_AUTHORITY_DISABLED",
		);
		expect(reader.inspect(session)).toEqual({ state: "legacy", owned: false });
		expect(existsSync(agentDir)).toBe(false);
	});
	it.each(["empty", "thinking", "model-thinking"])("binds the complete audited %s initialization prefix", (prefix) => {
		if (prefix === "model-thinking") session.model();
		if (prefix !== "empty") session.thinking();
		const prefixCount = session.entries.length;
		const token = source();
		expect(token.data.prefixLength).toBe(prefixCount);
		expect(session.entries[prefixCount].type).toBe("custom");
		expect(bridge.inspect(session).state).toBe("unsealed");
		refused();
	});
	it("publishes a content-free durable barrier before exposing the first claim", () => {
		const token = begin();
		const bytes = readFileSync(barrierFile(), "utf8");
		expect(existsSync(session.file)).toBe(false);
		expect(session.entries).toHaveLength(0);
		expect(bytes).not.toContain("Synthetic reviewed directive");
		expect(bytes).not.toContain(root);
		expect(statSync(barrierFile()).mode & 0o777).toBe(0o600);
		expect(Object.isFrozen(token)).toBe(true);
		expect(Object.isFrozen(token.data)).toBe(true);
		expect(bridge.inspect(session).state).toBe("pending");
		refused(new PreviewAuthorityBridge(agentDir));
	});
	it("retains pending ownership when a first custom claim is buffered and after restart", () => {
		const token = begin();
		session.appendCustom(token.customType, token.data);
		expect(existsSync(session.file)).toBe(false);
		expect(bridge.inspect(session).state).toBe("pending");
		const reader = new PreviewAuthorityBridge(agentDir);
		expect(reader.inspect(session.reopen()).state).toBe("pending");
		refused(reader, session.reopen());
	});
	it("confirms full original bindings then marks only ownership active", () => {
		active();
		const reader = new PreviewAuthorityBridge(agentDir);
		expect(reader.inspect(session.reopen())).toEqual({
			state: "active",
			owned: true,
			code: "CONTEXT_AUTHORITY_UNSUPPORTED_READER",
		});
		refused(reader, session.reopen());
	});
	it.each(["pending", "unsealed", "active"])(
		"feature-disabled readers still refuse every operation in %s ownership",
		(state) => {
			if (state === "pending") begin();
			if (state === "unsealed") source();
			if (state === "active") active();
			const reader = new PreviewAuthorityBridge(agentDir, { enabled: false });
			expect(reader.inspect(session).state).toBe(state);
			refused(reader);
		},
	);
	it.each(["source", "custom", "model-only", "reordered", "extra-thinking", "bad-chain", "extra-field"])(
		"rejects unaudited %s prefixes rather than retrofitting old history",
		(damage) => {
			if (damage === "source") session.appendSource();
			if (damage === "custom") session.appendCustom("synthetic-custom", {});
			if (damage === "model-only") session.model();
			if (damage === "reordered") {
				session.thinking();
				session.model();
			}
			if (damage === "extra-thinking") {
				session.thinking();
				session.thinking();
			}
			if (damage === "bad-chain") {
				session.thinking();
				session.entries[0].parentId = "missing";
			}
			if (damage === "extra-field") {
				session.thinking();
				Object.defineProperty(session.entries[0], "extra", { enumerable: true, value: "unsupported" });
			}
			expect(() => begin()).toThrow(/CONTEXT_AUTHORITY_/);
			expect(existsSync(barrierFile())).toBe(false);
		},
	);
	it("does not enroll a new header that already identifies a fork parent", () => {
		session.header.parentSession = join(root, "synthetic-parent.jsonl");
		expect(() => begin()).toThrow("CONTEXT_AUTHORITY_INVALID");
		expect(existsSync(barrierFile())).toBe(false);
	});
	it.each(["cwd", "timestamp", "parentSession"] as const)(
		"retains initial header identity after a same-id/path %s rewrite",
		(key) => {
			begin();
			session.header[key] = key === "timestamp" ? "2026-02-01T00:00:00.000Z" : "synthetic-changed";
			session.persist();
			expect(new PreviewAuthorityBridge(agentDir).inspect(session).state).toBe("tampered");
			refused(new PreviewAuthorityBridge(agentDir));
		},
	);
	it("detects a regenerated session ID at the same physical file path", () => {
		begin();
		session.header.id = "different-session";
		session.persist();
		expect(new PreviewAuthorityBridge(agentDir).inspect(session).state).toBe("tampered");
	});
	it("retains sealed initial header identity when memory and disk are rewritten together", () => {
		active();
		session.header.cwd = "synthetic-changed";
		session.persist();
		const reader = new PreviewAuthorityBridge(agentDir);
		expect(reader.inspect(session.reopen()).state).toBe("tampered");
		refused(reader);
	});
	it("binds an unflushed initialization prefix before the claim is appended", () => {
		session.model();
		session.thinking();
		begin();
		const model = session.entries[0];
		if (model.type !== "model_change") throw new Error("Missing synthetic model change");
		model.modelId = "synthetic-changed-model";
		expect(bridge.inspect(session).state).toBe("tampered");
		refused();
	});
	it("does not release a source token if the first durable publication fails", () => {
		vi.spyOn(failureIo, "writeMarker").mockImplementation(() => {
			throw new Error("synthetic-publication-failure");
		});
		expect(() => begin()).toThrow("CONTEXT_AUTHORITY_IO");
		expect(session.entries).toHaveLength(0);
		expect(existsSync(session.file)).toBe(false);
		expect(existsSync(barrierFile())).toBe(false);
		refused();
		// No bytes means no promise of durable strict intent after a repaired-storage restart.
		expect(new PreviewAuthorityBridge(agentDir).inspect(session).state).toBe("legacy");
	});
	it("lets a setup caller mark a no-byte enrollment failure for independent replacement readers", () => {
		session.thinking();
		vi.spyOn(failureIo, "writeMarker").mockImplementation(() => {
			throw new Error("synthetic-publication-failure");
		});
		expect(() => begin()).toThrow("CONTEXT_AUTHORITY_IO");
		refused();
		// A private helper latch cannot protect the reader constructed by a replacement runtime.
		expect(new PreviewAuthorityBridge(agentDir).inspect(session)).toEqual({ state: "legacy", owned: false });
		// The setup callback must publish this content-free memory sentinel before rethrowing.
		session.appendCustom(`${AUTHORITY_PROTOCOL_PREFIX}enrollment-incomplete`, {});
		const replacement = new PreviewAuthorityBridge(agentDir);
		expect(replacement.inspect(session).state).toBe("unsupported");
		refused(replacement);
		expect(session.entries.map((entry) => entry.type)).toEqual(["thinking_level_change", "custom"]);
		expect(existsSync(session.file)).toBe(false);
		expect(existsSync(barrierFile())).toBe(false);
		// A nonexistent original file provides no durable ownership witness after process restart.
	});
	it("retains the published barrier when first-source flush fails", () => {
		const token = begin();
		session.appendCustom(token.customType, token.data);
		vi.spyOn(session, "persist").mockImplementation(() => {
			throw new Error("synthetic-source-flush-failure");
		});
		expect(() => session.appendSource()).toThrow("synthetic-source-flush-failure");
		expect(bridge.inspect(session).state).toBe("tampered");
		refused();
		expect(new PreviewAuthorityBridge(agentDir).inspect(session.reopen()).state).toBe("pending");
	});
	it("requires the root claim before the first expected source", () => {
		begin();
		session.appendSource();
		expect(bridge.inspect(session).state).toBe("tampered");
		refused();
	});
	it("refuses an unexpected source payload even when both memory and disk match", () => {
		const token = begin();
		session.appendCustom(token.customType, token.data);
		session.appendSource({ ...reviewed, content: "Synthetic changed directive." });
		expect(() => bridge.confirmSource(session, token)).toThrow("CONTEXT_AUTHORITY_INVALID");
		refused(new PreviewAuthorityBridge(agentDir));
	});
	it("does not confirm memory-only source data before disk readback", () => {
		const token = begin();
		session.appendCustom(token.customType, token.data);
		expect(() => bridge.confirmSource(session, token)).toThrow("CONTEXT_AUTHORITY_INVALID");
		refused();
	});
	it("binds helper tokens to their exact public-manager instance and process", () => {
		const token = source();
		const sameFileManager = session.reopen();
		expect(() => bridge.createSealClaim(sameFileManager, token)).toThrow("CONTEXT_AUTHORITY_INVALID");
		expect(() => new PreviewAuthorityBridge(agentDir, { enabled: true }).createSealClaim(session, token)).toThrow(
			"CONTEXT_AUTHORITY_INVALID",
		);
		expect(() => bridge.createSealClaim(session, { ...token })).toThrow("CONTEXT_AUTHORITY_INVALID");
	});
	it.each(["content", "entry-timestamp", "entry-id"])(
		"detects confirmed-source %s tampering after restart",
		(damage) => {
			source();
			const original = session.entries[1];
			if (original.type !== "message" || original.message.role !== "user")
				throw new Error("Missing synthetic source");
			if (damage === "content") original.message.content = "Synthetic changed directive.";
			if (damage === "entry-timestamp") original.timestamp = "2026-02-01T00:00:00.000Z";
			if (damage === "entry-id") {
				original.id = "changed-source";
				session.leafId = original.id;
			}
			session.persist();
			expect(new PreviewAuthorityBridge(agentDir).inspect(session.reopen()).state).toBe("tampered");
		},
	);
	it.each(["claim", "prefix", "source", "none"])(
		"keeps session-wide active ownership while selecting %s before the seal",
		(leaf) => {
			session.thinking();
			active();
			session.leafId =
				leaf === "prefix"
					? session.entries[0].id
					: leaf === "claim"
						? session.entries[1].id
						: leaf === "source"
							? session.entries[2].id
							: null;
			expect(bridge.inspect(session).state).toBe("active");
			refused();
		},
	);
	it("rejects a duplicate ownership claim on an unselected sibling", () => {
		const token = source();
		const selected = session.leafId;
		session.leafId = session.entries[0].id;
		session.appendCustom(token.customType, token.data);
		session.leafId = selected;
		expect(bridge.inspect(session).state).toBe("tampered");
		refused();
	});
	it("rejects an unknown reserved protocol on any sibling", () => {
		source();
		const selected = session.leafId;
		session.leafId = session.entries[0].id;
		session.appendCustom(`${AUTHORITY_PROTOCOL_PREFIX}future-claim`, {});
		session.leafId = selected;
		expect(bridge.inspect(session).state).toBe("unsupported");
		refused();
	});
	it("never treats malformed known ownership data as an ordinary custom entry", () => {
		session.appendCustom(AUTHORITY_CLAIM_TYPE, {});
		session.appendSource();
		expect(new PreviewAuthorityBridge(agentDir).inspect(session).owned).toBe(true);
		refused();
	});
	it("keeps a copied strict claim refusing at a new fork identity/path without grants", () => {
		active();
		const fork = new BridgeSession(root, "synthetic-fork");
		fork.header.parentSession = session.file;
		fork.entries = structuredClone(session.entries);
		fork.leafId = session.leafId;
		fork.persist();
		expect(new PreviewAuthorityBridge(agentDir).inspect(fork).state).toBe("tampered");
		refused(new PreviewAuthorityBridge(agentDir), fork);
	});
	it("does not recreate a deleted ownership sidecar from a claim", () => {
		active();
		rmSync(barrierFile());
		expect(new PreviewAuthorityBridge(agentDir).inspect(session.reopen()).state).toBe("tampered");
		refused(new PreviewAuthorityBridge(agentDir));
		expect(existsSync(barrierFile())).toBe(false);
	});
	it.each(["malformed", "unknown-contract", "oversized"])(
		"keeps %s barrier data blocking rather than self-resetting",
		(damage) => {
			begin();
			if (damage === "malformed") writeFileSync(barrierFile(), "{");
			if (damage === "oversized") writeFileSync(barrierFile(), " ".repeat(4097));
			if (damage === "unknown-contract") {
				const original = JSON.parse(readFileSync(barrierFile(), "utf8")) as Record<string, unknown>;
				writeFileSync(barrierFile(), JSON.stringify({ ...original, contract: "future-protocol" }));
			}
			const bytes = readFileSync(barrierFile());
			refused(new PreviewAuthorityBridge(agentDir));
			expect(() => begin()).toThrow(/CONTEXT_AUTHORITY_/);
			expect(readFileSync(barrierFile())).toEqual(bytes);
		},
	);
	it("does not let ordinary explicit retry replace the independent ownership barrier", () => {
		source();
		const ownershipBytes = readFileSync(barrierFile());
		const old = new PreviewFailureStore(agentDir);
		old.begin(session, true);
		expect(bridge.inspect(session).owned).toBe(true);
		const beginOld = vi.spyOn(old, "begin");
		expect(() => {
			bridge.assertLegacy(session, "retry");
			old.begin(session, true);
		}).toThrow(/CONTEXT_AUTHORITY_/);
		expect(beginOld).not.toHaveBeenCalled();
		expect(readFileSync(barrierFile())).toEqual(ownershipBytes);
	});
	it("retains unsealed ownership when source-binding publication fails", () => {
		const token = begin();
		session.appendCustom(token.customType, token.data);
		session.appendSource();
		vi.spyOn(failureIo, "writeMarker").mockImplementation(() => {
			throw new Error("synthetic-binding-failure");
		});
		expect(() => bridge.confirmSource(session, token)).toThrow("CONTEXT_AUTHORITY_IO");
		expect(new PreviewAuthorityBridge(agentDir).inspect(session.reopen()).state).toBe("unsealed");
		refused();
	});
	it("retains unsealed ownership when seal confirmation fails", () => {
		const token = source();
		const seal = bridge.createSealClaim(session, token);
		const id = session.appendCustom(seal.customType, seal.data);
		vi.spyOn(failureIo, "writeMarker").mockImplementation(() => {
			throw new Error("synthetic-seal-confirm-failure");
		});
		expect(() => bridge.confirmSeal(session, token, id)).toThrow("CONTEXT_AUTHORITY_IO");
		expect(new PreviewAuthorityBridge(agentDir).inspect(session.reopen()).state).toBe("unsealed");
		refused();
	});
	it("does not confirm a seal ID absent from original persisted records", () => {
		const token = source();
		expect(() => bridge.confirmSeal(session, token, "missing-seal")).toThrow("CONTEXT_AUTHORITY_INVALID");
		refused();
	});
	it("checks a seal through a complete intervening descendant chain", () => {
		const token = source();
		for (let index = 0; index < 128; index++) session.appendCustom("synthetic-receipt", { index });
		const seal = bridge.createSealClaim(session, token);
		const id = session.appendCustom(seal.customType, seal.data);
		bridge.confirmSeal(session, token, id);
		expect(new PreviewAuthorityBridge(agentDir).inspect(session.reopen()).state).toBe("active");
		refused();
	});
	it("refuses an ownership seal on a sibling outside the confirmed source ancestry", () => {
		session.thinking();
		const token = source();
		const seal = bridge.createSealClaim(session, token);
		session.leafId = session.entries[0].id;
		const id = session.appendCustom(seal.customType, seal.data);
		expect(() => bridge.confirmSeal(session, token, id)).toThrow("CONTEXT_AUTHORITY_INVALID");
		refused(new PreviewAuthorityBridge(agentDir));
	});
	it.each(["malformed-line", "missing-final-LF", "duplicate-id", "unknown-parent", "second-root"])(
		"reads the complete file and refuses %s even if a manager skips damage",
		(damage) => {
			active();
			if (damage === "malformed-line") writeFileSync(session.file, `${readFileSync(session.file, "utf8")}\n{\n`);
			if (damage === "missing-final-LF") writeFileSync(session.file, readFileSync(session.file, "utf8").trimEnd());
			if (damage === "duplicate-id") {
				session.entries.push(structuredClone(session.entries[0]));
				session.persist();
			}
			if (damage === "unknown-parent") {
				session.appendCustom("synthetic-sibling", {});
				session.entries.at(-1)!.parentId = "missing";
				session.persist();
			}
			if (damage === "second-root") {
				session.appendCustom("synthetic-sibling", {});
				session.entries.at(-1)!.parentId = null;
				session.persist();
			}
			expect(new PreviewAuthorityBridge(agentDir).inspect(session.reopen()).state).toBe("tampered");
		},
	);
	it("reads the entire original file and ownership marker on every guard", () => {
		active();
		const reader = new PreviewAuthorityBridge(agentDir);
		const read = vi.spyOn(failureIo, "readBoundedFile");
		refused(reader);
		expect(read.mock.calls.filter(([file]) => file === session.file)).toHaveLength(actions.length);
		expect(read.mock.calls.filter(([file]) => file === barrierFile())).toHaveLength(actions.length);
	});
	it.each(["symlink", "hardlink"])("rejects a %s original file rather than weakening ownership readback", (kind) => {
		active();
		const original = join(root, "synthetic-copy.jsonl");
		writeFileSync(original, readFileSync(session.file));
		rmSync(session.file);
		if (kind === "symlink") symlinkSync(original, session.file);
		else linkSync(original, session.file);
		refused(new PreviewAuthorityBridge(agentDir));
	});
	it("does not use symlinked private ownership directories", () => {
		const destination = join(root, "synthetic-foreign-dir");
		mkdirSync(destination);
		mkdirSync(join(agentDir, "context-memory-preview"), { recursive: true });
		symlinkSync(destination, join(agentDir, "context-memory-preview", "authority"));
		expect(() => begin()).toThrow(/CONTEXT_AUTHORITY_/);
		refused();
	});
	it("bounds the operational directory before adding another durable enrollment", () => {
		const directory = join(agentDir, "context-memory-preview", "authority");
		mkdirSync(directory, { recursive: true });
		for (let index = 0; index < 64; index++)
			writeFileSync(join(directory, `${index.toString(16).padStart(64, "0")}.json`), "{}");
		expect(() => begin()).toThrow("CONTEXT_AUTHORITY_CAPACITY");
		expect(existsSync(barrierFile())).toBe(false);
		refused();
	});
	it("does not infer authority ownership from quoted words or ordinary note/custom text", () => {
		session.appendCustom("context-memory-note", { state: [{ text: `${AUTHORITY_SEAL_TYPE} is quoted evidence.` }] });
		session.appendSource({ ...reviewed, content: `${AUTHORITY_CLAIM_TYPE} ${AUTHORITY_PROTOCOL_PREFIX}quoted` });
		expect(bridge.inspect(session)).toEqual({ state: "legacy", owned: false });
	});
});

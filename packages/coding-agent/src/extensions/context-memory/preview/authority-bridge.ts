import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	opendirSync,
	openSync,
	realpathSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { UserMessage } from "@earendil-works/pi-ai";
import type { SessionEntry, SessionHeader } from "@earendil-works/pi-coding-agent";
import { hashEntries, isRecord } from "../identity.ts";
import type { PreviewSession } from "./contracts.ts";
import { canonicalSessionFile, missing, readBoundedFile, writeMarker } from "./failure-io.ts";

// Prototype capability names, not assigned checkpoint/release format numbers.
export const AUTHORITY_BRIDGE_CAPABILITY = "authority-ownership-bridge";
export const AUTHORITY_PROTOCOL_PREFIX = "context-memory-authority:";
export const AUTHORITY_CLAIM_TYPE = `${AUTHORITY_PROTOCOL_PREFIX}ownership`;
export const AUTHORITY_SEAL_TYPE = `${AUTHORITY_PROTOCOL_PREFIX}ownership-seal`;
const CONTRACT = "strict-ownership";
const MAX_STATE_BYTES = 4096;
const MAX_SESSION_BYTES = 64 * 1024 * 1024;
const MAX_SESSION_ENTRIES = 250_000;
const MAX_BARRIERS = 64;
const MAX_DIRECTORY_ENTRIES = 128;
const MAX_SOURCE_BYTES = 128 * 1024;

export type AuthorityBridgeAction = "dispatch" | "compact" | "retry" | "recover" | "navigate" | "fork";
export type AuthorityBridgeState = "legacy" | "pending" | "unsealed" | "active" | "unsupported" | "tampered";
export interface AuthorityBridgeStatus {
	state: AuthorityBridgeState;
	owned: boolean;
	code?: string;
}
export class AuthorityBridgeError extends Error {
	readonly code: string;
	constructor(code: string) {
		super(code);
		this.code = code;
	}
}

interface OwnershipClaim {
	contract: typeof CONTRACT;
	minimumReader: typeof AUTHORITY_BRIDGE_CAPABILITY;
	enrollmentId: string;
	sessionId: string;
	fileHash: string;
	headerHash: string;
	messageHash: string;
	prefixLength: number;
	prefixLeafId: string | null;
	prefixHash: string;
}
interface SourceBinding {
	claimId: string;
	claimHash: string;
	sourceId: string;
	sourceHash: string;
}
interface OwnershipSeal extends OwnershipClaim, SourceBinding {}
interface Barrier extends OwnershipClaim {
	phase: "pending" | "unsealed" | "active";
	source?: SourceBinding;
	sealId?: string;
	sealHash?: string;
}
export interface AuthorityEnrollment {
	readonly customType: typeof AUTHORITY_CLAIM_TYPE;
	readonly data: Readonly<OwnershipClaim>;
}
export interface AuthoritySealClaim {
	readonly customType: typeof AUTHORITY_SEAL_TYPE;
	readonly data: Readonly<OwnershipSeal>;
}
interface Identity {
	sessionId: string;
	file: string;
	fileHash: string;
	header: SessionHeader;
}
interface View {
	identity: Identity;
	entries: readonly SessionEntry[];
	byId: ReadonlyMap<string, SessionEntry>;
	roots: number;
	persisted: boolean;
}
interface Ownership {
	claim: SessionEntry;
	source?: SessionEntry;
	seal?: SessionEntry;
	binding?: SourceBinding;
}
const CLAIM_KEYS = [
	"contract",
	"minimumReader",
	"enrollmentId",
	"sessionId",
	"fileHash",
	"headerHash",
	"messageHash",
	"prefixLength",
	"prefixLeafId",
	"prefixHash",
];
const SOURCE_KEYS = ["claimId", "claimHash", "sourceId", "sourceHash"];
const ENTRY_KEYS = ["type", "id", "parentId", "timestamp"];

function fail(code = "CONTEXT_AUTHORITY_INVALID"): never {
	throw new AuthorityBridgeError(code);
}
function identifier(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9:_.-]{1,128}$/.test(value);
}
function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}
function hash(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function keys(value: object, allowed: readonly string[]): boolean {
	return Object.keys(value).every((key) => allowed.includes(key));
}
function errorCode(error: unknown): string {
	return error instanceof AuthorityBridgeError ? error.code : "CONTEXT_AUTHORITY_IO";
}
function claim(value: unknown): OwnershipClaim {
	if (!isRecord(value)) fail();
	if (value.contract !== CONTRACT || value.minimumReader !== AUTHORITY_BRIDGE_CAPABILITY)
		fail("CONTEXT_AUTHORITY_UNSUPPORTED");
	if (
		!keys(value, CLAIM_KEYS) ||
		!identifier(value.enrollmentId) ||
		!identifier(value.sessionId) ||
		!hash(value.fileHash) ||
		!hash(value.headerHash) ||
		!hash(value.messageHash) ||
		!hash(value.prefixHash) ||
		!Number.isSafeInteger(value.prefixLength) ||
		(value.prefixLength !== 0 && value.prefixLength !== 1 && value.prefixLength !== 2) ||
		(value.prefixLeafId !== null && !identifier(value.prefixLeafId)) ||
		(value.prefixLength === 0) !== (value.prefixLeafId === null)
	)
		fail();
	return value as unknown as OwnershipClaim;
}
function sourceBinding(value: unknown): SourceBinding {
	if (
		!isRecord(value) ||
		!keys(value, SOURCE_KEYS) ||
		!identifier(value.claimId) ||
		!identifier(value.sourceId) ||
		!hash(value.claimHash) ||
		!hash(value.sourceHash)
	)
		fail();
	return value as unknown as SourceBinding;
}
function base(value: OwnershipClaim): OwnershipClaim {
	return {
		contract: value.contract,
		minimumReader: value.minimumReader,
		enrollmentId: value.enrollmentId,
		sessionId: value.sessionId,
		fileHash: value.fileHash,
		headerHash: value.headerHash,
		messageHash: value.messageHash,
		prefixLength: value.prefixLength,
		prefixLeafId: value.prefixLeafId,
		prefixHash: value.prefixHash,
	};
}
function sameClaim(left: OwnershipClaim, right: OwnershipClaim): boolean {
	return CLAIM_KEYS.every((key) => Reflect.get(left, key) === Reflect.get(right, key));
}
function sameSource(left: SourceBinding, right: SourceBinding): boolean {
	return SOURCE_KEYS.every((key) => Reflect.get(left, key) === Reflect.get(right, key));
}
function parseBarrier(value: unknown): Barrier {
	if (!isRecord(value) || !keys(value, [...CLAIM_KEYS, "phase", "source", "sealId", "sealHash"])) fail();
	const ownership = claim(Object.fromEntries(CLAIM_KEYS.map((key) => [key, value[key]])));
	if (value.phase !== "pending" && value.phase !== "unsealed" && value.phase !== "active") fail();
	if (
		value.phase === "pending"
			? value.source !== undefined || value.sealId !== undefined || value.sealHash !== undefined
			: value.source === undefined
	)
		fail();
	if (
		value.phase === "active"
			? !identifier(value.sealId) || !hash(value.sealHash)
			: value.sealId !== undefined || value.sealHash !== undefined
	)
		fail();
	return {
		...ownership,
		phase: value.phase,
		...(value.source === undefined ? {} : { source: sourceBinding(value.source) }),
		...(value.phase === "active" ? { sealId: value.sealId as string, sealHash: value.sealHash as string } : {}),
	};
}

/** A commitment to reviewed input; this helper does not authenticate or approve a user act. */
export function authoritySourceHash(message: UserMessage): string {
	if (
		!isRecord(message) ||
		!keys(message, ["role", "content", "timestamp"]) ||
		message.role !== "user" ||
		!Number.isSafeInteger(message.timestamp) ||
		message.timestamp < 0
	)
		fail();
	if (
		typeof message.content !== "string" &&
		(!Array.isArray(message.content) ||
			!message.content.every(
				(part) =>
					isRecord(part) && keys(part, ["type", "text"]) && part.type === "text" && typeof part.text === "string",
			))
	)
		fail();
	const serialized = JSON.stringify(message);
	if (Buffer.byteLength(serialized, "utf8") > MAX_SOURCE_BYTES) fail("CONTEXT_AUTHORITY_CAPACITY");
	return digest(serialized);
}
function protocol(entry: SessionEntry): "claim" | "seal" | "unknown" | undefined {
	if (
		(entry.type === "custom" || entry.type === "custom_message") &&
		entry.customType.startsWith(AUTHORITY_PROTOCOL_PREFIX)
	) {
		if (entry.type === "custom" && entry.customType === AUTHORITY_CLAIM_TYPE) return "claim";
		if (entry.type === "custom" && entry.customType === AUTHORITY_SEAL_TYPE) return "seal";
		return "unknown";
	}
	if (
		entry.type === "compaction" &&
		isRecord(entry.details) &&
		typeof entry.details.kind === "string" &&
		entry.details.kind.startsWith("pi-context-memory-authority")
	)
		return "unknown";
	return undefined;
}
function initializationPrefix(entries: readonly SessionEntry[]): void {
	if (!entries.length) return;
	if (entries.length > 2) fail();
	const thinking = entries.at(-1);
	if (
		!thinking ||
		thinking.type !== "thinking_level_change" ||
		!keys(thinking, [...ENTRY_KEYS, "thinkingLevel"]) ||
		!["off", "minimal", "low", "medium", "high", "xhigh"].includes(thinking.thinkingLevel)
	)
		fail();
	if (entries.length === 2) {
		const model = entries[0];
		if (
			model.type !== "model_change" ||
			!keys(model, [...ENTRY_KEYS, "provider", "modelId"]) ||
			typeof model.provider !== "string" ||
			!model.provider ||
			model.provider.length > 256 ||
			typeof model.modelId !== "string" ||
			!model.modelId ||
			model.modelId.length > 256
		)
			fail();
	}
	for (let index = 0; index < entries.length; index++)
		if (
			!identifier(entries[index].id) ||
			typeof entries[index].timestamp !== "string" ||
			entries[index].parentId !== (entries[index - 1]?.id ?? null)
		)
			fail();
}
function identity(session: PreviewSession): Identity {
	const sessionId = session.getSessionId();
	const header = session.getHeader();
	const path = session.getSessionFile();
	if (
		!identifier(sessionId) ||
		!header ||
		header.type !== "session" ||
		header.version !== 3 ||
		header.id !== sessionId ||
		typeof header.timestamp !== "string" ||
		typeof header.cwd !== "string" ||
		!path
	)
		fail("CONTEXT_AUTHORITY_UNSUPPORTED");
	const file = canonicalSessionFile(path, session.getSessionDir());
	return { sessionId, file, fileHash: digest(file), header };
}
function readView(session: PreviewSession): View {
	const current = identity(session);
	const memory = session.getEntries();
	let bytes: Buffer;
	try {
		bytes = readBoundedFile(current.file, MAX_SESSION_BYTES, "CONTEXT_AUTHORITY_INVALID");
	} catch (error) {
		if (missing(error)) {
			if (memory.some((entry) => entry.type === "message" || entry.type === "compaction")) fail();
			return {
				identity: current,
				entries: memory,
				byId: new Map(memory.map((entry) => [entry.id, entry])),
				roots: memory.filter((entry) => entry.parentId === null).length,
				persisted: false,
			};
		}
		throw error;
	}
	const text = bytes.toString("utf8");
	if (!text.endsWith("\n")) fail();
	const lines = text.slice(0, -1).split("\n");
	if (lines.length > MAX_SESSION_ENTRIES + 1) fail("CONTEXT_AUTHORITY_CAPACITY");
	const header: unknown = JSON.parse(lines.shift() ?? "");
	if (
		!isRecord(header) ||
		header.type !== "session" ||
		header.version !== 3 ||
		header.id !== current.sessionId ||
		hashEntries([header]) !== hashEntries([current.header])
	)
		fail();
	const entries: SessionEntry[] = [];
	const byId = new Map<string, SessionEntry>();
	let roots = 0;
	for (const line of lines) {
		const value: unknown = JSON.parse(line);
		if (
			!isRecord(value) ||
			!identifier(value.id) ||
			typeof value.type !== "string" ||
			value.type === "session" ||
			typeof value.timestamp !== "string" ||
			(value.parentId !== null && (!identifier(value.parentId) || !byId.has(value.parentId))) ||
			byId.has(value.id)
		)
			fail();
		if (value.parentId === null) roots++;
		const entry = value as unknown as SessionEntry;
		byId.set(value.id, entry);
		entries.push(entry);
	}
	if (
		hashEntries(entries) !== hashEntries(memory) ||
		(session.getLeafId() !== null && !byId.has(session.getLeafId() ?? ""))
	)
		fail();
	return { identity: current, entries, byId, roots, persisted: true };
}

function syncDirectory(path: string): void {
	const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try {
		if (!fstatSync(fd).isDirectory()) fail("CONTEXT_AUTHORITY_IO");
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}
function privateDirectory(path: string, create: boolean): boolean {
	let created = false;
	if (create) {
		try {
			mkdirSync(path, { mode: 0o700 });
			created = true;
		} catch (error) {
			if (!isRecord(error) || error.code !== "EEXIST") throw error;
		}
	}
	try {
		const stat = lstatSync(path);
		if (!stat.isDirectory() || stat.isSymbolicLink()) fail("CONTEXT_AUTHORITY_IO");
	} catch (error) {
		if (!create && missing(error)) return false;
		throw error;
	}
	if (created) {
		syncDirectory(path);
		syncDirectory(dirname(path));
	}
	return true;
}
function barrierDirectory(agentDir: string, create: boolean): string | undefined {
	if (create) {
		const created = mkdirSync(agentDir, { recursive: true, mode: 0o700 });
		if (created) {
			const stop = realpathSync(dirname(created));
			let path = realpathSync(agentDir);
			while (path !== stop) {
				syncDirectory(path);
				path = dirname(path);
				syncDirectory(path);
			}
		}
	}
	let root: string;
	try {
		root = realpathSync(agentDir);
	} catch (error) {
		if (!create && missing(error)) return undefined;
		throw error;
	}
	const preview = join(root, "context-memory-preview");
	const barriers = join(preview, "authority");
	return privateDirectory(preview, create) && privateDirectory(barriers, create) ? barriers : undefined;
}
function readBarrier(agentDir: string, current: Identity): Barrier | undefined {
	const directory = barrierDirectory(agentDir, false);
	if (!directory) return undefined;
	try {
		return parseBarrier(
			JSON.parse(
				readBoundedFile(
					join(directory, `${current.fileHash}.json`),
					MAX_STATE_BYTES,
					"CONTEXT_AUTHORITY_INVALID",
				).toString("utf8"),
			),
		);
	} catch (error) {
		if (missing(error)) return undefined;
		throw error;
	}
}
function writeBarrier(agentDir: string, current: Identity, value: Barrier): void {
	if (Buffer.byteLength(JSON.stringify(value), "utf8") + 1 > MAX_STATE_BYTES) fail("CONTEXT_AUTHORITY_CAPACITY");
	const directory = barrierDirectory(agentDir, true);
	if (!directory) fail("CONTEXT_AUTHORITY_IO");
	const dir = opendirSync(directory);
	let count = 0;
	let barriers = 0;
	let exists = false;
	try {
		for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
			if (++count >= MAX_DIRECTORY_ENTRIES || !entry.isFile()) fail("CONTEXT_AUTHORITY_CAPACITY");
			if (/^[a-f0-9]{64}\.json$/.test(entry.name)) {
				barriers++;
				if (entry.name === `${current.fileHash}.json`) exists = true;
			} else if (!/^\.pending-[a-f0-9-]{36}$/.test(entry.name)) fail("CONTEXT_AUTHORITY_IO");
		}
	} finally {
		dir.closeSync();
	}
	if (barriers > MAX_BARRIERS || (!exists && barriers >= MAX_BARRIERS)) fail("CONTEXT_AUTHORITY_CAPACITY");
	writeMarker(join(directory, `${current.fileHash}.json`), value);
}
function ownership(view: View, barrier: Barrier): Ownership | undefined {
	if (
		view.roots !== (view.entries.length ? 1 : 0) ||
		barrier.sessionId !== view.identity.sessionId ||
		barrier.fileHash !== view.identity.fileHash ||
		barrier.headerHash !== hashEntries([view.identity.header])
	)
		fail();
	const claims = view.entries.filter((entry) => protocol(entry) === "claim");
	const seals = view.entries.filter((entry) => protocol(entry) === "seal");
	if (claims.length > 1 || seals.length > 1) fail();
	if (!claims.length) {
		if (barrier.phase !== "pending" || seals.length) fail();
		initializationPrefix(view.entries);
		if (view.entries.length !== barrier.prefixLength || hashEntries(view.entries) !== barrier.prefixHash) fail();
		return undefined;
	}
	const root = claims[0];
	if (
		root.type !== "custom" ||
		!sameClaim(claim(root.data), barrier) ||
		view.entries.indexOf(root) !== barrier.prefixLength ||
		root.parentId !== barrier.prefixLeafId
	)
		fail();
	const prefix = view.entries.slice(0, barrier.prefixLength);
	initializationPrefix(prefix);
	if (hashEntries(prefix) !== barrier.prefixHash) fail();
	const source = view.entries[barrier.prefixLength + 1];
	if (!source) {
		if (barrier.phase !== "pending" || seals.length) fail();
		return { claim: root };
	}
	if (
		!view.persisted ||
		source.type !== "message" ||
		source.message.role !== "user" ||
		source.parentId !== root.id ||
		authoritySourceHash(source.message) !== barrier.messageHash
	)
		fail();
	const binding = {
		claimId: root.id,
		claimHash: hashEntries([root]),
		sourceId: source.id,
		sourceHash: hashEntries([source]),
	};
	if (barrier.source && !sameSource(binding, barrier.source)) fail();
	const seal = seals[0];
	if (seal) {
		if (seal.type !== "custom" || !isRecord(seal.data) || !keys(seal.data, [...CLAIM_KEYS, ...SOURCE_KEYS])) fail();
		const sealData = seal.data;
		const sealedClaim = claim(Object.fromEntries(CLAIM_KEYS.map((key) => [key, sealData[key]])));
		const sealedSource = sourceBinding(Object.fromEntries(SOURCE_KEYS.map((key) => [key, sealData[key]])));
		if (
			!sameClaim(sealedClaim, barrier) ||
			!sameSource(sealedSource, binding) ||
			view.entries.indexOf(seal) <= view.entries.indexOf(source)
		)
			fail();
		let parent = seal.parentId;
		while (parent !== null && parent !== source.id) parent = view.byId.get(parent)?.parentId ?? null;
		if (parent !== source.id) fail();
	}
	if (barrier.phase === "active" && (!seal || seal.id !== barrier.sealId || hashEntries([seal]) !== barrier.sealHash))
		fail();
	return { claim: root, source, binding, ...(seal ? { seal } : {}) };
}

/**
 * OFF-by-default bootstrap primitive and minimum rollback reader. It never admits
 * authority projection, authenticates intake, appends history, or clears ownership.
 * Call assertLegacy BEFORE every old compaction/retry/recovery/navigation/fork path.
 */
export class PreviewAuthorityBridge {
	private readonly agentDir: string;
	private readonly enabled: boolean;
	private readonly tokens = new WeakMap<AuthorityEnrollment, { session: PreviewSession; ownership: OwnershipClaim }>();
	private readonly latched = new Map<string, string>();
	constructor(agentDir: string, options: { enabled?: boolean } = {}) {
		this.agentDir = resolve(agentDir);
		this.enabled = options.enabled === true;
	}
	inspect(session: PreviewSession): AuthorityBridgeStatus {
		try {
			if (this.latched.has(session.getSessionId()))
				return { state: "tampered", owned: true, code: this.latched.get(session.getSessionId()) };
			if (!session.getSessionFile())
				return session.getEntries().some((entry) => protocol(entry))
					? { state: "unsupported", owned: true, code: "CONTEXT_AUTHORITY_UNSUPPORTED" }
					: { state: "legacy", owned: false };
			const view = readView(session);
			const barrier = readBarrier(this.agentDir, view.identity);
			const types = view.entries.map(protocol);
			if (types.includes("unknown"))
				return { state: "unsupported", owned: true, code: "CONTEXT_AUTHORITY_UNSUPPORTED" };
			if (!barrier)
				return types.some(Boolean)
					? { state: "tampered", owned: true, code: "CONTEXT_AUTHORITY_INVALID" }
					: { state: "legacy", owned: false };
			const original = ownership(view, barrier);
			if (barrier.phase === "active")
				return { state: "active", owned: true, code: "CONTEXT_AUTHORITY_UNSUPPORTED_READER" };
			return original?.source
				? { state: "unsealed", owned: true, code: "CONTEXT_AUTHORITY_UNSEALED" }
				: { state: "pending", owned: true, code: "CONTEXT_AUTHORITY_PENDING" };
		} catch (error) {
			const code = errorCode(error);
			return { state: code === "CONTEXT_AUTHORITY_UNSUPPORTED" ? "unsupported" : "tampered", owned: true, code };
		}
	}
	assertLegacy(session: PreviewSession, _action: AuthorityBridgeAction): void {
		const status = this.inspect(session);
		if (status.state !== "legacy") fail(status.code ?? "CONTEXT_AUTHORITY_UNSUPPORTED_READER");
	}
	beginEnrollment(session: PreviewSession, expectedMessageHash: string): AuthorityEnrollment {
		if (!this.enabled) fail("CONTEXT_AUTHORITY_DISABLED");
		try {
			if (!hash(expectedMessageHash)) fail();
			this.assertLegacy(session, "dispatch");
			const view = readView(session);
			if (view.identity.header.parentSession !== undefined) fail();
			initializationPrefix(view.entries);
			if (session.getLeafId() !== (view.entries.at(-1)?.id ?? null)) fail();
			const data: OwnershipClaim = {
				contract: CONTRACT,
				minimumReader: AUTHORITY_BRIDGE_CAPABILITY,
				enrollmentId: randomUUID(),
				sessionId: view.identity.sessionId,
				fileHash: view.identity.fileHash,
				headerHash: hashEntries([view.identity.header]),
				messageHash: expectedMessageHash,
				prefixLength: view.entries.length,
				prefixLeafId: view.entries.at(-1)?.id ?? null,
				prefixHash: hashEntries(view.entries),
			};
			// No source/claim token escapes unless atomic publication and fsync complete.
			writeBarrier(this.agentDir, view.identity, { ...data, phase: "pending" });
			const token = Object.freeze({ customType: AUTHORITY_CLAIM_TYPE, data: Object.freeze(data) });
			this.tokens.set(token, { session, ownership: data });
			return token;
		} catch (error) {
			this.latched.set(session.getSessionId(), errorCode(error));
			throw new AuthorityBridgeError(errorCode(error));
		}
	}
	private enrolled(
		session: PreviewSession,
		token: AuthorityEnrollment,
	): { view: View; barrier: Barrier; original: Ownership } {
		if (!this.enabled) fail("CONTEXT_AUTHORITY_DISABLED");
		if (this.latched.has(session.getSessionId())) fail(this.latched.get(session.getSessionId()));
		const remembered = this.tokens.get(token);
		if (!remembered || remembered.session !== session) fail();
		const view = readView(session);
		const barrier = readBarrier(this.agentDir, view.identity);
		if (
			!barrier ||
			!sameClaim(barrier, remembered.ownership) ||
			view.entries.some((entry) => protocol(entry) === "unknown")
		)
			fail();
		const original = ownership(view, barrier);
		if (!original?.source || !original.binding || !view.persisted) fail();
		return { view, barrier, original };
	}
	confirmSource(session: PreviewSession, token: AuthorityEnrollment): void {
		try {
			const { view, barrier, original } = this.enrolled(session, token);
			if (barrier.phase === "active" || !original.binding) fail();
			writeBarrier(this.agentDir, view.identity, { ...base(barrier), phase: "unsealed", source: original.binding });
		} catch (error) {
			this.latched.set(session.getSessionId(), errorCode(error));
			throw new AuthorityBridgeError(errorCode(error));
		}
	}
	createSealClaim(session: PreviewSession, token: AuthorityEnrollment): AuthoritySealClaim {
		const { barrier, original } = this.enrolled(session, token);
		if (barrier.phase !== "unsealed" || !original.binding || original.seal) fail();
		return Object.freeze({
			customType: AUTHORITY_SEAL_TYPE,
			data: Object.freeze({ ...base(barrier), ...original.binding }),
		});
	}
	confirmSeal(session: PreviewSession, token: AuthorityEnrollment, sealId: string): void {
		try {
			const { view, barrier, original } = this.enrolled(session, token);
			if (barrier.phase !== "unsealed" || !original.binding || !original.seal || original.seal.id !== sealId) fail();
			writeBarrier(this.agentDir, view.identity, {
				...base(barrier),
				phase: "active",
				source: original.binding,
				sealId,
				sealHash: hashEntries([original.seal]),
			});
		} catch (error) {
			this.latched.set(session.getSessionId(), errorCode(error));
			throw new AuthorityBridgeError(errorCode(error));
		}
	}
}

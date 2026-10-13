import { createHash } from "node:crypto";
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
	type Stats,
} from "node:fs";
import { dirname, join } from "node:path";
import { isRecord } from "../identity.ts";
import { missing, readBoundedFile, writeMarker } from "./failure-io.ts";

export const MAX_PREPARATION_STATE_BYTES = 512 * 1024;
const MAX_DIRECTORY_ENTRIES = 128;
const MAX_SESSION_LEDGERS = 64;
const ledgerName = /^[a-f0-9]{64}\.json$/;
const temporaryName = /^\.pending-[a-f0-9-]{36}$/;

function syncDirectory(path: string): void {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
	try {
		if (!fstatSync(fd).isDirectory()) throw new Error("ledger-io");
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
	let stat: Stats;
	try {
		stat = lstatSync(path);
	} catch (error) {
		if (!create && missing(error)) return false;
		throw error;
	}
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("ledger-io");
	if (created) {
		syncDirectory(path);
		syncDirectory(dirname(path));
	}
	return true;
}

/** The user-selected root may be a symlink; accounting descendants may not be. */
function directory(agentDir: string, create: boolean): string | undefined {
	if (create) {
		const created = mkdirSync(agentDir, { recursive: true, mode: 0o700 });
		if (created !== undefined) {
			const stop = realpathSync(dirname(created));
			let current = realpathSync(agentDir);
			while (current !== stop) {
				syncDirectory(current);
				current = dirname(current);
				syncDirectory(current);
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
	const accounting = join(preview, "preparation");
	if (!privateDirectory(preview, create) || !privateDirectory(accounting, create)) return undefined;
	return accounting;
}

function assertDirectoryCapacity(path: string, sessionHash: string): void {
	const dir = opendirSync(path);
	let entries = 0;
	let ledgers = 0;
	let existing = false;
	try {
		for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
			if (++entries > MAX_DIRECTORY_ENTRIES) throw new Error("ledger-capacity");
			if (!entry.isFile() || (!ledgerName.test(entry.name) && !temporaryName.test(entry.name)))
				throw new Error("ledger-io");
			if (ledgerName.test(entry.name)) {
				ledgers++;
				if (entry.name === `${sessionHash}.json`) existing = true;
			}
		}
	} finally {
		dir.closeSync();
	}
	// Include the atomic publication's temporary inode in the bounded directory.
	if (
		entries >= MAX_DIRECTORY_ENTRIES ||
		ledgers > MAX_SESSION_LEDGERS ||
		(!existing && ledgers >= MAX_SESSION_LEDGERS)
	)
		throw new Error("ledger-capacity");
}

export function readPreparationState(agentDir: string, sessionHash: string): Buffer | undefined {
	const path = directory(agentDir, false);
	if (!path) return undefined;
	try {
		return readBoundedFile(join(path, `${sessionHash}.json`), MAX_PREPARATION_STATE_BYTES, "ledger-invalid");
	} catch (error) {
		if (missing(error)) return undefined;
		throw error;
	}
}

/** A successful return includes aggregate/detail publication and file/directory fsync. */
export function writePreparationState(agentDir: string, sessionHash: string, value: unknown): Buffer {
	const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
	if (bytes.length > MAX_PREPARATION_STATE_BYTES) throw new Error("ledger-capacity");
	const path = directory(agentDir, true);
	if (!path) throw new Error("ledger-io");
	assertDirectoryCapacity(path, sessionHash);
	writeMarker(join(path, `${sessionHash}.json`), value);
	return bytes;
}

export function preparationStateHash(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

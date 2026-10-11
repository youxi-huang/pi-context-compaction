import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readSync,
	realpathSync,
	renameSync,
	type Stats,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { isRecord } from "../identity.ts";

export class PreviewStoreError extends Error {
	readonly code: string;

	constructor(code: string) {
		super(`${code}: context compaction requires an explicit successful manual retry`);
		this.code = code;
	}
}

export function missing(error: unknown): boolean {
	return isRecord(error) && error.code === "ENOENT";
}

export function storeErrorCode(error: unknown, fallback: string): string {
	return error instanceof PreviewStoreError ? error.code : fallback;
}

function sameFile(left: Stats, right: Stats): boolean {
	return (
		left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs
	);
}

/** Reads only regular non-symlink files, with bounded allocation and a stable file identity. */
export function readBoundedFile(file: string, limit: number, code: string): Buffer {
	let fd: number | undefined;
	let data: Buffer;
	try {
		const initial = lstatSync(file);
		if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1 || initial.size > limit)
			throw new PreviewStoreError(code);
		fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const opened = fstatSync(fd);
		if (!sameFile(initial, opened) || !opened.isFile()) throw new PreviewStoreError(code);
		data = Buffer.alloc(opened.size);
		let offset = 0;
		while (offset < data.length) {
			const count = readSync(fd, data, offset, data.length - offset, offset);
			if (!count) throw new PreviewStoreError(code);
			offset += count;
		}
		const extra = Buffer.alloc(1);
		if (readSync(fd, extra, 0, 1, data.length) || !sameFile(opened, fstatSync(fd))) throw new PreviewStoreError(code);
	} catch (error) {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				// Preserve the read or validation error if descriptor cleanup also fails.
			}
		}
		throw error;
	}
	closeSync(fd);
	return data;
}

function syncDirectory(path: string): void {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
	try {
		if (!fstatSync(fd).isDirectory()) throw new PreviewStoreError("CONTEXT_PREVIEW_MARKER_IO");
		fsyncSync(fd);
	} catch (error) {
		try {
			closeSync(fd);
		} catch {
			// Preserve the directory sync failure.
		}
		throw error;
	}
	closeSync(fd);
}

function ensurePrivateDirectory(path: string): void {
	let created = false;
	try {
		mkdirSync(path, { mode: 0o700 });
		created = true;
	} catch (error) {
		if (!isRecord(error) || error.code !== "EEXIST") throw error;
	}
	const stat = lstatSync(path);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new PreviewStoreError("CONTEXT_PREVIEW_MARKER_IO");
	if (created) {
		syncDirectory(path);
		syncDirectory(dirname(path));
	}
}

/** The user-selected agentDir may be a symlink; private descendants may not be. */
export function markerDirectory(agentDir: string): string {
	const created = mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	const root = realpathSync(agentDir);
	if (created !== undefined) {
		const stop = realpathSync(dirname(created));
		let current = root;
		while (current !== stop) {
			syncDirectory(current);
			const parent = dirname(current);
			syncDirectory(parent);
			current = parent;
		}
	}
	const preview = join(root, "context-memory-preview");
	const failures = join(preview, "failures");
	ensurePrivateDirectory(preview);
	ensurePrivateDirectory(failures);
	return failures;
}

export function canonicalSessionFile(file: string, sessionDir: string): string {
	const absolute = resolve(file);
	const parent = realpathSync(dirname(absolute));
	if (parent !== realpathSync(resolve(sessionDir))) throw new PreviewStoreError("CONTEXT_PREVIEW_SESSION_INVALID");
	return join(parent, basename(absolute));
}

function assertMarkerTarget(file: string): void {
	try {
		const stat = lstatSync(file);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
			throw new PreviewStoreError("CONTEXT_PREVIEW_MARKER_INVALID");
	} catch (error) {
		if (!missing(error)) throw error;
	}
}

/** Publication is atomic, and successful return includes file and directory fsync. */
export function writeMarker(file: string, value: unknown): void {
	assertMarkerTarget(file);
	const temporary = join(dirname(file), `.pending-${randomUUID()}`);
	let fd: number | undefined;
	let created = false;
	try {
		fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
		created = true;
		writeFileSync(fd, `${JSON.stringify(value)}\n`, "utf8");
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		assertMarkerTarget(file);
		renameSync(temporary, file);
		created = false;
		syncDirectory(dirname(file));
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				// The original IO error remains authoritative.
			}
		}
		if (created) {
			try {
				unlinkSync(temporary);
			} catch {
				// No successful publication is reported, even if cleanup also fails.
			}
		}
	}
}

export function removeMarker(file: string): void {
	assertMarkerTarget(file);
	unlinkSync(file);
	syncDirectory(dirname(file));
}

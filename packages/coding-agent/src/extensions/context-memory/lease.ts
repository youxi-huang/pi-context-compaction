import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { isRecord } from "./identity.ts";

interface Owner {
	pid: number;
	processStart: string;
	bootId: string;
	runtimeId: string;
	nonce: string;
	recoveryRequired?: string;
}

export type ProcessIdentity = Pick<Owner, "pid" | "processStart" | "bootId">;

function processStart(pid: number): string | undefined {
	try {
		if (process.platform === "linux") {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
		}
		return execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" }).trim() || undefined;
	} catch {
		return undefined;
	}
}

function bootIdentity(): string {
	if (process.platform === "linux") return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
	if (process.platform === "darwin")
		return execFileSync("sysctl", ["-n", "kern.boottime"], { encoding: "utf8" }).trim();
	throw new Error("CONTEXT_LOCK_PLATFORM: process identity is supported on macOS and Linux only");
}

let localIdentity: Pick<Owner, "pid" | "processStart" | "bootId"> | undefined;
function identity(): NonNullable<typeof localIdentity> {
	if (!localIdentity) {
		const started = processStart(process.pid);
		if (!started) throw new Error("CONTEXT_LOCK_IDENTITY: cannot determine this process's start time");
		localIdentity = { pid: process.pid, processStart: started, bootId: bootIdentity() };
	}
	return localIdentity;
}

export function currentProcessIdentity(): ProcessIdentity {
	return { ...identity() };
}
export function isProcessIdentityAlive(owner: ProcessIdentity): boolean {
	return owner.bootId === identity().bootId && processStart(owner.pid) === owner.processStart;
}

function ownerAt(path: string): Owner {
	const owner: unknown = JSON.parse(readFileSync(join(path, "owner.json"), "utf8"));
	if (
		!isRecord(owner) ||
		!Number.isSafeInteger(owner.pid) ||
		Number(owner.pid) <= 0 ||
		![owner.processStart, owner.bootId, owner.runtimeId, owner.nonce].every(
			(value) => typeof value === "string" && value.length > 0,
		)
	) {
		throw new Error(`CONTEXT_LOCK_UNKNOWN: incomplete owner metadata at ${path}; inspect manually`);
	}
	return owner as unknown as Owner;
}

function isDead(owner: Owner): boolean {
	if (owner.bootId !== identity().bootId) return true;
	try {
		process.kill(owner.pid, 0);
	} catch (error) {
		return isRecord(error) && error.code === "ESRCH";
	}
	const started = processStart(owner.pid);
	return started !== undefined && started !== owner.processStart;
}

const held = new Set<SessionLease>();
let cleanupInstalled = false;

export function canonicalSessionPath(file: string): string {
	const absolute = resolve(file);
	return existsSync(absolute) ? realpathSync(absolute) : join(realpathSync(dirname(absolute)), basename(absolute));
}

/** Cooperative, per-runtime writer lease. Elapsed time never establishes ownership. */
export class SessionLease {
	readonly file: string;
	readonly lockPath: string;
	private readonly owner: Owner;
	private released = false;

	private constructor(file: string, runtimeId: string) {
		this.file = file;
		this.lockPath = `${file}.context.lock`;
		this.owner = { ...identity(), runtimeId, nonce: randomUUID() };
	}

	static acquire(file: string, runtimeId = randomUUID()): SessionLease {
		const canonical = canonicalSessionPath(file);
		const lease = new SessionLease(canonical, runtimeId);
		try {
			mkdirSync(lease.lockPath, { mode: 0o700 });
		} catch (error) {
			if (!isRecord(error) || error.code !== "EEXIST") throw error;
			const owner = ownerAt(lease.lockPath);
			if (owner.recoveryRequired)
				throw new Error(`CONTEXT_STORAGE_UNCERTAIN: ${owner.recoveryRequired}; inspect ${lease.lockPath} manually`);
			if (!isDead(owner))
				throw new Error(`CONTEXT_LOCKED: ${canonical} is owned by PID ${owner.pid}, runtime ${owner.runtimeId}`);
			const reaper = `${lease.lockPath}.reap`;
			// A crashed reaper leaves this marker for explicit inspection, never a timeout takeover.
			mkdirSync(reaper, { mode: 0o700 });
			try {
				const current = ownerAt(lease.lockPath);
				if (current.nonce !== owner.nonce || !isDead(current))
					throw new Error("CONTEXT_LOCK_CHANGED: retry acquisition");
				const retired = `${lease.lockPath}.retired-${owner.nonce}`;
				renameSync(lease.lockPath, retired);
				mkdirSync(lease.lockPath, { mode: 0o700 });
				rmSync(retired, { recursive: true });
			} finally {
				rmSync(reaper, { recursive: true });
			}
		}
		try {
			writeFileSync(join(lease.lockPath, "owner.json"), JSON.stringify(lease.owner), { flag: "wx", mode: 0o600 });
		} catch (error) {
			// Leave an incomplete lock rather than permit an ambiguous writer.
			throw new Error(`CONTEXT_LOCK_UNKNOWN: could not initialize ${lease.lockPath}`, { cause: error });
		}
		held.add(lease);
		if (!cleanupInstalled) {
			cleanupInstalled = true;
			process.once("exit", () => {
				for (const active of held) {
					try {
						active.release();
					} catch {
						/* Preserve uncertain ownership for inspection. */
					}
				}
			});
		}
		return lease;
	}

	assert(): void {
		if (this.released) throw new Error("CONTEXT_LOCK_CLOSED: session storage is closed");
		const current = ownerAt(this.lockPath);
		if (
			current.nonce !== this.owner.nonce ||
			current.runtimeId !== this.owner.runtimeId ||
			current.pid !== process.pid ||
			current.processStart !== this.owner.processStart ||
			current.bootId !== this.owner.bootId
		) {
			throw new Error(`CONTEXT_LOCK_LOST: ${this.file}`);
		}
	}

	release(): void {
		if (this.released) return;
		if (this.owner.recoveryRequired) return;
		this.assert();
		rmSync(this.lockPath, { recursive: true });
		this.released = true;
		held.delete(this);
	}

	requireRecovery(reason: string): void {
		this.owner.recoveryRequired = reason;
		try {
			writeFileSync(join(this.lockPath, "owner.json"), JSON.stringify(this.owner), { mode: 0o600 });
		} catch {
			/* Never release this lock; incomplete metadata also requires manual inspection. */
		}
	}
}

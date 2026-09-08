import { SessionLease } from "../../src/extensions/context-memory/lease.ts";

const lease = SessionLease.acquire(process.argv[2]);
process.send?.({ locked: true });
process.on("message", () => {
	lease.release();
	process.exit(0);
});

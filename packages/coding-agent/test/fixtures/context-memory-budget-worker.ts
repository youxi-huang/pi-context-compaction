import { SessionManager } from "../../src/core/session-manager.ts";
import { freezeHistory, queryHistory } from "../../src/extensions/context-memory/history.ts";
import { latestMemory } from "../../src/extensions/context-memory/notes.ts";

const store = SessionManager.open(process.argv[2]);
let fork: SessionManager | undefined;
try {
	const memory = latestMemory(store.getBranch());
	const page = queryHistory(freezeHistory(store), { operation: "read", entryId: process.argv[3] });
	const cwd = store.getCwd();
	const sessionDir = store.getSessionDir();
	store.close(); // forkFrom acquires its own source lease; never compete with our open reader.
	fork = SessionManager.forkFrom(process.argv[2], cwd, sessionDir);
	console.log(
		JSON.stringify({
			hardTokens: memory?.memory.noteBudget?.hardTokens,
			retrieved: page.entries[0]?.entryId,
			forked: Boolean(latestMemory(fork.getBranch())),
		}),
	);
} finally {
	fork?.close();
	store.close();
}

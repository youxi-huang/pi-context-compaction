import type { Session, SessionStore } from "@deepseek-ai/dsh-session";
import type { SessionPersistence } from "@deepseek-ai/dsh-session-persistence";
import { queryHistory } from "../../compaction-core/src/history.ts";
import { dshHistorySnapshot } from "./codec.ts";

export async function readDshHistory(
	sessions: Pick<SessionStore, "flush">,
	persistence: Pick<SessionPersistence, "open">,
	session: Session,
	request: unknown,
	signal: AbortSignal,
) {
	signal.throwIfAborted();
	if (!(await sessions.flush(session))) throw new Error("HISTORY_PERSISTENCE_REQUIRED");
	signal.throwIfAborted();
	const handle = await persistence.open(session.id, "read", { signal });
	try {
		if (handle.id !== session.id || handle.header.id !== session.id || handle.header.isSeeded)
			throw new Error("HISTORY_SCOPE_DENIED: only the current unseeded session is supported");
		const { events } = await handle.read(undefined, undefined, { signal });
		signal.throwIfAborted();
		return queryHistory(dshHistorySnapshot(session.id, events), request);
	} finally {
		await handle.close();
	}
}

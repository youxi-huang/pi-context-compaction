import { adoptHistoryGrant } from "../../src/extensions/context-memory/grant-file.ts";
import { grantedHistory, queryHistory } from "../../src/extensions/context-memory/history.ts";

const grant = adoptHistoryGrant(process.argv[2], process.argv[3]);
process.send?.({ ready: true });
process.on("message", () => {
	try {
		const result = queryHistory(grantedHistory(grant.grantId, process.argv[3]), {
			operation: "read",
			entryId: process.argv[4],
		});
		process.send?.({ text: result.entries[0]?.text });
	} catch (error) {
		process.send?.({ error: error instanceof Error ? error.message : String(error) });
	}
});

/** Public, read-only integration surface for side questions and child-session hosts. */
export { CONTEXT_MEMORY_BUILD } from "./build.ts";
export { adoptHistoryGrant, saveHistoryGrant } from "./grant-file.ts";
export {
	freezeHistory,
	grantedHistory,
	type HistoryGrant,
	type HistoryPage,
	type HistoryQuery,
	type HistorySnapshot,
	historyQuerySchema,
	issueHistoryGrant,
	queryHistory,
	revokeHistoryGrant,
} from "./history.ts";
export { latestMemory, renderNote } from "./notes.ts";
export { assertReadableBranch } from "./storage.ts";
export { sumMemoryUsage as sumUsage } from "./writer.ts";

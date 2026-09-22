import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	DEFAULT_COMPACTION_SETTINGS,
	prepareCompaction,
} from "../../packages/coding-agent/src/core/compaction/compaction.ts";
import { type CompactionEntry, SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
import {
	DEFAULT_MEMORY_CONFIG,
	memoryBudget,
	selectNoteBudget,
	textTokens,
} from "../../packages/coding-agent/src/extensions/context-memory/config.ts";
import { chooseCut } from "../../packages/coding-agent/src/extensions/context-memory/controller.ts";
import { EVENT_LOG_FILE, type MemoryEvent } from "../../packages/coding-agent/src/extensions/context-memory/events.ts";
import { CONTEXT_KEEP_NONE, hashEntries } from "../../packages/coding-agent/src/extensions/context-memory/identity.ts";
import {
	compactedSourceTokens,
	latestMemory,
	noteBytes,
	sourceText,
} from "../../packages/coding-agent/src/extensions/context-memory/notes.ts";
import { FIXTURE_VERSION, RUNTIME_PIN } from "../schema.ts";
import { artifactDirectory, evalRoot, json, loadFixture } from "../test-utils.ts";
import { model, note, offlineHost } from "./offline-host.ts";
import { inspectReferences, summarizeReferences } from "./structural.ts";

describe("fixture trigger preflight and real checkpoint recovery", () => {
	it("prepares, commits and reopens all twelve declared arm/checkpoint combinations offline", async () => {
		const root = artifactDirectory("stage1-preflight-");
		const fetchGuard = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			throw new Error("EVAL_NO_NETWORK");
		});
		const rows: Record<string, unknown>[] = [];
		try {
			for (const name of ["F1", "F2", "F3"]) {
				const { fixture, branch: original, header } = loadFixture(name);
				if (name === "F3") expect(prepareCompaction(original, DEFAULT_COMPACTION_SETTINGS)).toBeUndefined();
				for (const arm of ["project", "native"] as const) {
					let clean: string = `${JSON.stringify(header)}\n`;
					let previousBoundary = -1;
					for (const [index, trigger] of fixture.triggers.entries()) {
						const boundary = original.findIndex((entry) => entry.id === trigger.afterEntryId);
						const increment = structuredClone(original.slice(previousBoundary + 1, boundary + 1));
						const oldLines = clean.trim().split("\n");
						increment[0].parentId = oldLines.length > 1 ? JSON.parse(oldLines.at(-1)!).id : null;
						const file = join(root, `${trigger.id}-${arm}.jsonl`);
						writeFileSync(file, clean + increment.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
						const store = SessionManager.open(file, root);
						const candidate = note(
							original[0].id,
							"Original source remains available; recover its decisions before acting.",
						);
						const host = await offlineHost(
							store,
							arm,
							join(root, `${trigger.id}-${arm}-host`),
							candidate,
							fixture.native.keepRecentTokens,
						);
						try {
							const before = structuredClone(store.getBranch());
							const settings = host.settings.getCompactionSettings(model);
							const preparation = prepareCompaction(before, settings);
							expect(preparation).toBeDefined();
							if (!preparation) throw new Error("EVAL_NO_PREPARATION");
							const active = new Set(store.buildContextEntries().map((entry) => entry.id));
							const cut =
								arm === "project"
									? chooseCut(before, 0, false)
									: before.findIndex((entry) => entry.id === preparation.firstKeptEntryId);
							const released = before.slice(0, cut).filter((entry) => active.has(entry.id) && sourceText(entry));
							const kept = before.slice(cut).filter((entry) => active.has(entry.id) && sourceText(entry));
							const releasedTokens = compactedSourceTokens(released);
							expect(releasedTokens).toBeGreaterThan(0);
							expect(compactedSourceTokens(before)).toBe(trigger.cumulativeSourceTokens);
							expect(settings.keepRecentTokens).toBe(arm === "project" ? 0 : fixture.native.keepRecentTokens);
							const prior = latestMemory(before);
							const previousNoteJsonTokens = prior ? Math.ceil(noteBytes(prior.memory.note) / 3) : 0;
							const budget =
								arm === "project"
									? selectNoteBudget(
											DEFAULT_MEMORY_CONFIG,
											memoryBudget(model).threshold,
											releasedTokens,
											previousNoteJsonTokens,
										)
									: null;
							if (name === "F2" && index === 0 && arm === "project") {
								expect(releasedTokens).toBe(82000);
								expect(budget?.tier).toBe(2);
							}
							const compacted = await host.session.compact();
							expect(compacted.firstKeptEntryId).toBe(
								cut === before.length ? CONTEXT_KEEP_NONE : before[cut].id,
							);
							const leaf = store.getLeafEntry() as CompactionEntry;
							const memory = latestMemory(store.getBranch());
							if (arm === "project") {
								expect(memory?.memory.coveredThrough).toBe(before.at(-1)?.id);
								expect(memory?.memory.sourceHash).toBe(hashEntries(before));
								expect(memory?.memory.noteBudget).toEqual(budget);
							}
							const finding = arm === "project" ? inspectReferences(candidate, before) : null;
							clean = readFileSync(file, "utf8");
							json(join(root, `${trigger.id}-${arm}-preparation.json`), {
								before,
								preparation,
								actualCut: compacted.firstKeptEntryId,
								releasedIds: released.map((e) => e.id),
								keptIds: kept.map((e) => e.id),
								budget,
								sourceHash: hashEntries(before),
							});
							host.session.dispose();
							store.close();
							const reopened = SessionManager.open(file, root);
							const resumed = await offlineHost(
								reopened,
								arm,
								join(root, `${trigger.id}-${arm}-reopen`),
								candidate,
								fixture.native.keepRecentTokens,
							);
							try {
								expect(reopened.getLeafId()).toBe(leaf.id);
								expect(reopened.getBranch().slice(0, before.length)).toEqual(before);
								expect(
									reopened
										.buildSessionContext()
										.messages.some(
											(message) => "summary" in message && message.summary === compacted.summary,
										),
								).toBe(true);
								resumed.taskMode();
								await resumed.session.prompt("Resume the recorded task.");
								expect(resumed.requests).toHaveLength(1);
								expect(JSON.stringify(resumed.requests)).toContain(
									JSON.stringify(compacted.summary).slice(1, -1),
								);
								json(join(root, `${trigger.id}-${arm}-requests.json`), {
									writer: host.requests,
									task: resumed.requests,
								});
							} finally {
								resumed.session.dispose();
								reopened.close();
							}
							const events: MemoryEvent[] =
								arm === "project"
									? readFileSync(join(host.agentDir, EVENT_LOG_FILE), "utf8")
											.trim()
											.split("\n")
											.map((line) => JSON.parse(line) as MemoryEvent)
									: [];
							const event = events.find((e) => e.event === "compaction");
							rows.push({
								fixture: name,
								checkpoint: trigger.id,
								arm,
								nativeLabel: fixture.native.label,
								keepRecentTokens: settings.keepRecentTokens,
								cumulativeSourceTokens: trigger.cumulativeSourceTokens,
								releasedTokens,
								retainedTokens: compactedSourceTokens(kept),
								releasedIds: released.map((e) => e.id),
								keptIds: kept.map((e) => e.id),
								firstKeptEntryId: compacted.firstKeptEntryId,
								fixtureBoundary: trigger.afterEntryId,
								originalPrefixHash: createHash("sha256")
									.update(JSON.stringify(original.slice(0, boundary + 1)))
									.digest("hex"),
								previousNoteJsonTokens,
								budget,
								capacityTruncationReason: null,
								previousNoteFloorEffective: false,
								repairUsed: event?.event === "compaction" ? event.repairUsed : null,
								noteJsonTokens: memory ? Math.ceil(noteBytes(memory.memory.note) / 3) : null,
								renderedSummaryTokens: textTokens(compacted.summary),
								lineageTokens: event?.event === "compaction" ? event.lineageTokens : null,
								continuationTokens: event?.event === "compaction" ? event.continuationTokens : null,
								writerCalls: host.requests.length,
								realProviderUsage: null,
								measurement: "scripted-offline",
								structural: finding,
								reopened: true,
								providerInputVerified: true,
							});
							previousBoundary = boundary;
						} finally {
							host.session.dispose();
							store.close();
						}
					}
				}
			}
			expect(fetchGuard).not.toHaveBeenCalled();
			const findings = rows.flatMap((row) =>
				row.structural ? [row.structural as ReturnType<typeof inspectReferences>] : [],
			);
			const report = {
				fixtureVersion: FIXTURE_VERSION,
				runtimePin: RUNTIME_PIN,
				providerMode: "scripted",
				realModelCalls: 0,
				model,
				thinking: "off",
				writer: { mode: "session", noteRepair: true },
				tools: { project: ["context_history"], native: [] },
				plannedCheckpoints: 12,
				attemptedCheckpoints: rows.length,
				successfulCheckpoints: rows.length,
				plannedRecoveryRequests: 12,
				completedRecoveryRequests: rows.length,
				structural: summarizeReferences(findings),
				comparisonCaveat:
					"Retention budgets differ. These are preparation/interface measurements, not semantic superiority claims.",
				rows,
			};
			json(join(root, "preflight.json"), report);
			json(join(process.env.EVAL_ARTIFACT_DIR!, "stage1-preflight-latest.json"), { directory: root });
			if (process.env.EVAL_WRITE_PREFLIGHT === "1") json(join(evalRoot, "fixtures/preflight.json"), report);
			else {
				const frozen = JSON.parse(readFileSync(join(evalRoot, "fixtures/preflight.json"), "utf8"));
				expect(report).toEqual(frozen);
			}
		} catch (error) {
			json(join(root, "failure.json"), { error: String(error), rows });
			throw error;
		} finally {
			fetchGuard.mockRestore();
		}
	}, 60000);
});

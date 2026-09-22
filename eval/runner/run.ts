import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { prepareCompaction } from "../../packages/coding-agent/src/core/compaction/compaction.ts";
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
	renderNote,
	sourceText,
} from "../../packages/coding-agent/src/extensions/context-memory/notes.ts";
import { assertExecutionMode, effectiveProbe, MEASUREMENT_VERSION } from "../live/contract.ts";
import { model as defaultModel } from "../pi/offline-host.ts";
import { inspectReferences } from "../pi/structural.ts";
import { FIXTURE_VERSION, type Probe, RUNTIME_PIN, SCORER_VERSION } from "../schema.ts";
import { type Observation, score, summarize } from "../scorer.ts";
import { json } from "../test-utils.ts";
import { ProbeBudget, type RunMeter } from "./budget.ts";
import { assertFrozenInputs, FIXTURE_CONTENT_HASH, FIXTURE_REVISION, runnerFingerprint } from "./frozen.ts";
import { createRunnerHost } from "./host.ts";
import type { Arm, CallRecord, CheckpointResult, ProbeResult, RunResult, Transport, WriterReviewer } from "./types.ts";
import { extendChain, initialFor, limitsFor, loadFrozenFixture, probeCopy, taskPrompt } from "./visibility.ts";
import { ProbeWorld } from "./world.ts";

export interface RunOptions {
	fixture: "F1" | "F2" | "F3";
	arm: Arm;
	replicate: number;
	outputDirectory: string;
	transport: Transport;
	model?: Model<Api>;
	thinkingLevel?: ThinkingLevel;
	writerReviewer?: WriterReviewer;
	maxCalls?: number;
	timeoutMs?: number;
	measurementVersion?: typeof MEASUREMENT_VERSION;
	minimalDaily?: boolean;
	writerOutputTokens?: 32768;
}

/** One run is one independent fixture × arm × replicate chain. No notes are reused between runs. */
export async function runEvaluation(options: RunOptions): Promise<RunResult> {
	assertExecutionMode(options.transport.mode);
	if (options.transport.mode === "live" && options.measurementVersion !== MEASUREMENT_VERSION)
		throw new Error("EVAL_LIVE_CONTRACT_REQUIRED");
	if (!Number.isSafeInteger(options.replicate) || options.replicate < 1) throw new Error("EVAL_REPLICATE_REQUIRED");
	if (
		!isAbsolute(options.outputDirectory) ||
		!Number.isSafeInteger(options.maxCalls ?? 500) ||
		(options.maxCalls ?? 500) < 1 ||
		!Number.isFinite(options.timeoutMs ?? 120000) ||
		(options.timeoutMs ?? 120000) <= 0
	)
		throw new Error("EVAL_VALID_OUTPUT_AND_BUDGET_REQUIRED");
	if (!["F1", "F2", "F3"].includes(options.fixture) || !["project", "native"].includes(options.arm))
		throw new Error("EVAL_UNKNOWN_ARM_OR_FIXTURE");
	assertFrozenInputs();
	const bundle = loadFrozenFixture(options.fixture);
	if (
		options.minimalDaily &&
		(options.fixture !== "F2" ||
			options.arm !== "project" ||
			options.maxCalls! < 1 ||
			options.maxCalls! > 8 ||
			options.timeoutMs !== 600000)
	)
		throw new Error("EVAL_MINIMAL_CONTRACT_MISMATCH");
	if (options.writerOutputTokens !== undefined && (!options.minimalDaily || options.writerOutputTokens !== 32768))
		throw new Error("EVAL_WRITER_OUTPUT_REVISION_REQUIRES_MINIMAL");
	const triggers = options.minimalDaily ? bundle.fixture.triggers.slice(0, 2) : bundle.fixture.triggers;
	const selectedProbes = bundle.fixture.probes.filter(
		(probe) =>
			!options.minimalDaily ||
			(triggers.some((trigger) => trigger.id === probe.checkpoint) && probe.oracle.kind === "continuation"),
	);
	const model = options.model ?? defaultModel;
	const id = `${options.fixture}-${options.arm}-r${options.replicate}-${randomUUID()}`;
	const directory = resolve(options.outputDirectory, id);
	mkdirSync(directory, { recursive: true });
	const privateDir = join(directory, "evaluator");
	mkdirSync(privateDir);
	json(join(privateDir, "gold.json"), bundle.fixture);
	writeFileSync(
		join(privateDir, "full-source.jsonl"),
		[bundle.header, ...bundle.branch].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
	);
	const fixtureHash = createHash("sha256").update(JSON.stringify(bundle.fixture)).digest("hex");
	const result: RunResult = {
		id,
		fixture: options.fixture,
		arm: options.arm,
		replicate: options.replicate,
		status: "completed",
		directory,
		metadata: {
			runnerVersion: "0.3-runner.2",
			minimalDaily: options.minimalDaily ?? false,
			writerProviderOutputTokens: options.writerOutputTokens ?? null,
			coverage: options.minimalDaily
				? "F2 first two checkpoints, one combined state/action/permission continuation each; not a full baseline"
				: "full fixture",
			runnerSourceHash: runnerFingerprint(),
			runtimePin: RUNTIME_PIN,
			fixtureRevision: FIXTURE_REVISION,
			fixtureContentHash: FIXTURE_CONTENT_HASH,
			fixtureVersion: FIXTURE_VERSION,
			fixtureHash,
			scorerVersion: SCORER_VERSION,
			providerMode: options.transport.mode,
			measurementVersion: options.measurementVersion ?? "0.3-measurement.1",
			realModelCalls: 0,
			model,
			thinking: options.thinkingLevel ?? "off",
			writer: "session",
			repair: true,
			nativeConfiguration: bundle.fixture.native,
			projectKeepRecentTokens: 0,
			visibleTools:
				options.arm === "project"
					? ["read", "write", "task_action", "context_history"]
					: ["read", "write", "task_action"],
			runLimits: { calls: options.maxCalls ?? 500, timeoutMs: options.timeoutMs ?? 120000 },
			comparisonCaveat:
				"Retained budgets differ; F3 native uses an explicitly configured zero-retention baseline. Scripted results are not provider-quality measurements.",
		},
		checkpoints: [],
		probes: [],
		counts: {},
		usage: {},
	};
	const meter: RunMeter = {
		calls: 0,
		maxCalls: options.maxCalls ?? 500,
		deadline: performance.now() + (options.timeoutMs ?? 120000),
		scope: { runId: id, fixture: options.fixture, arm: options.arm, replicate: options.replicate },
		writerTimeoutMs: options.minimalDaily ? 600000 : options.measurementVersion ? 180000 : 60000,
		writerOutputTokens: options.writerOutputTokens,
	};
	let clean = `${JSON.stringify(bundle.header)}\n`;
	let previousBoundary = -1;
	let chainError: string | undefined;
	const blocked = (probe: Probe, error: string): ProbeResult => {
		const oracle = probe.oracle;
		return {
			id: probe.id,
			target: probe.target,
			checkpoint: probe.checkpoint,
			status: "blocked",
			error,
			score: score(bundle.fixture, probe, undefined, bundle.records, undefined, true),
			requests: [],
			toolTrace: [],
			injection:
				oracle.kind === "authority" &&
				bundle.fixture.authorities.some(
					(a) => a.id === oracle.authorityId && a.measurement === "offline-injection-only",
				),
		};
	};
	for (const trigger of triggers) {
		if (!chainError && (meter.calls >= meter.maxCalls || performance.now() >= meter.deadline)) {
			chainError = meter.calls >= meter.maxCalls ? "EVAL_RUN_CALL_LIMIT" : "EVAL_RUN_TIMEOUT";
			result.status = "failed";
		}
		const checkpoint: CheckpointResult = {
			id: trigger.id,
			status: chainError ? "blocked" : "failed",
			releasedTokens: 0,
			cumulativeSourceTokens: trigger.cumulativeSourceTokens,
			requests: [],
		};
		result.checkpoints.push(checkpoint);
		const probes = selectedProbes
			.filter((probe) => probe.checkpoint === trigger.id)
			.map((probe) => effectiveProbe(probe, options.measurementVersion));
		meter.scope = { ...meter.scope!, checkpoint: trigger.id, probe: undefined };
		if (chainError) {
			checkpoint.error = chainError;
			result.probes.push(...probes.map((probe) => blocked(probe, chainError!)));
			continue;
		}
		const boundary = bundle.branch.findIndex((entry) => entry.id === trigger.afterEntryId);
		const last = bundle.branch[boundary];
		if (last.type !== "message" || last.message.role !== "assistant" || last.message.stopReason !== "stop")
			throw new Error("EVAL_NOT_COMPLETED_TURN");
		const chainFile = join(directory, `${trigger.id}-chain.jsonl`);
		writeFileSync(chainFile, extendChain(clean, bundle.branch.slice(previousBoundary + 1, boundary + 1)));
		const store = SessionManager.open(chainFile, directory);
		let host: Awaited<ReturnType<typeof createRunnerHost>> | undefined;
		try {
			const writerDirectory = join(directory, `${trigger.id}-writer`);
			const writerWorld = new ProbeWorld(
				join(writerDirectory, "workspace"),
				new ProbeBudget({ actions: 2, toolRounds: 3, outputTokens: 1024, calls: 4, timeoutMs: 30000 }),
				{},
			);
			host = await createRunnerHost({
				store,
				arm: options.arm,
				nativeKeep: bundle.fixture.native.keepRecentTokens,
				directory: writerDirectory,
				world: writerWorld,
				transport: options.transport,
				model,
				thinkingLevel: options.thinkingLevel,
				meter,
				purpose: "writer",
				records: checkpoint.requests,
			});
			const before = structuredClone(store.getBranch());
			const settings = host.settings.getCompactionSettings(model);
			checkpoint.effectiveThinkingLevel = host.session.thinkingLevel;
			if (settings.keepRecentTokens !== (options.arm === "project" ? 0 : bundle.fixture.native.keepRecentTokens))
				throw new Error("EVAL_RETENTION_DRIFT");
			const preparation = prepareCompaction(before, settings);
			if (!preparation) throw new Error("EVAL_NOTHING_TO_COMPACT");
			const cut =
				options.arm === "project"
					? chooseCut(before, 0, false)
					: before.findIndex((entry) => entry.id === preparation.firstKeptEntryId);
			const active = new Set(store.buildContextEntries().map((entry) => entry.id));
			const released = before.slice(0, cut).filter((entry) => active.has(entry.id) && sourceText(entry));
			const kept = before.slice(cut).filter((entry) => active.has(entry.id) && sourceText(entry));
			checkpoint.preparedReleaseTokens = compactedSourceTokens(released);
			if (checkpoint.preparedReleaseTokens <= 0) throw new Error("EVAL_EMPTY_RELEASE");
			checkpoint.keptTokens = compactedSourceTokens(kept);
			checkpoint.sourceHash = hashEntries(before);
			const previous = latestMemory(before);
			checkpoint.budget =
				options.arm === "project"
					? selectNoteBudget(
							DEFAULT_MEMORY_CONFIG,
							memoryBudget(model).threshold,
							checkpoint.preparedReleaseTokens,
							previous ? Math.ceil(noteBytes(previous.memory.note) / 3) : 0,
						)
					: null;
			json(join(privateDir, `${trigger.id}-preparation.json`), {
				preparation,
				sourceHash: checkpoint.sourceHash,
				declaredBoundary: trigger.afterEntryId,
				before,
				released: released.map((e) => e.id),
				kept: kept.map((e) => e.id),
				budget: checkpoint.budget,
			});
			checkpoint.triggerAt = performance.now();
			const compacted = await host.session.compact();
			checkpoint.committedAt = performance.now();
			if (compacted.firstKeptEntryId !== (cut === before.length ? CONTEXT_KEEP_NONE : before[cut].id))
				throw new Error("EVAL_COMMITTED_CUT_MISMATCH");
			checkpoint.firstKeptEntryId = compacted.firstKeptEntryId;
			const memory = latestMemory(store.getBranch());
			if (
				memory &&
				(memory.memory.sourceHash !== checkpoint.sourceHash || memory.memory.coveredThrough !== before.at(-1)?.id)
			)
				throw new Error("EVAL_CHECKPOINT_MISMATCH");
			checkpoint.structural = memory ? inspectReferences(memory.memory.note, before) : undefined;
			checkpoint.noteJsonTokens = memory ? Math.ceil(noteBytes(memory.memory.note) / 3) : undefined;
			checkpoint.renderedNoteTokens = textTokens(memory ? renderNote(memory.memory.note) : compacted.summary);
			const events: MemoryEvent[] =
				options.arm === "project"
					? readFileSync(join(host.agentDir, EVENT_LOG_FILE), "utf8")
							.trim()
							.split("\n")
							.map((line) => JSON.parse(line) as MemoryEvent)
					: [];
			const event = events.find((item) => item.event === "compaction");
			checkpoint.repairUsed = event?.event === "compaction" ? (event.repairUsed ?? false) : null;
			if (memory?.memory.noteBudget) {
				const policy = memory.memory.noteBudget;
				const withoutFloor = selectNoteBudget(
					DEFAULT_MEMORY_CONFIG,
					memoryBudget(model).threshold,
					policy.sourceTokens,
					0,
				);
				checkpoint.previousNoteFloorEffective =
					policy.baseTokens > withoutFloor.baseTokens || policy.hardTokens > withoutFloor.hardTokens;
				checkpoint.capacityTruncationReason =
					policy.baseTokens <
						Math.max([3000, 4000, 5000, 6000][policy.tier - 1], Math.ceil(policy.previousTokens * 0.9)) ||
					policy.hardTokens < Math.max([4000, 5000, 6000, 8000][policy.tier - 1], policy.previousTokens)
						? "threshold-or-storage-cap"
						: null;
			}
			checkpoint.lineageTokens = event?.event === "compaction" ? event.lineageTokens : 0;
			checkpoint.continuationTokens = event?.event === "compaction" ? event.continuationTokens : 0;
			clean = readFileSync(chainFile, "utf8");
			checkpoint.file = join(directory, `${trigger.id}-checkpoint.jsonl`);
			writeFileSync(checkpoint.file, clean);
			checkpoint.status = "committed";
			checkpoint.releasedTokens = checkpoint.preparedReleaseTokens;
			previousBoundary = boundary;
		} catch (error) {
			checkpoint.error = String(error);
			chainError = checkpoint.error;
			result.status = "failed";
		} finally {
			host?.session.dispose();
			store.close();
		}
		if (chainError || !checkpoint.file) {
			result.probes.push(...probes.map((probe) => blocked(probe, chainError ?? "EVAL_NO_CHECKPOINT")));
			continue;
		}
		// Task targets run first so evaluator artifact review does not become part of foreground pause.
		for (const probe of [...probes].sort(
			(a, b) => Number(a.target === "writer-artifact") - Number(b.target === "writer-artifact"),
		)) {
			if (probe.target === "task" && (meter.calls >= meter.maxCalls || performance.now() >= meter.deadline)) {
				result.probes.push(
					blocked(probe, meter.calls >= meter.maxCalls ? "EVAL_RUN_CALL_LIMIT" : "EVAL_RUN_TIMEOUT"),
				);
				continue;
			}
			meter.scope = { ...meter.scope!, probe: probe.id };
			const probeDirectory = join(directory, "probes", probe.id);
			mkdirSync(probeDirectory, { recursive: true });
			const copyFile = join(probeDirectory, "session.jsonl");
			const { injection } = probeCopy(checkpoint.file, copyFile, bundle.fixture, probe);
			const probeStore = SessionManager.open(copyFile, probeDirectory);
			const requests: CallRecord[] = [];
			let taskHost: Awaited<ReturnType<typeof createRunnerHost>> | undefined;
			let world: ProbeWorld | undefined;
			let budget: ProbeBudget | undefined;
			let output: ProbeResult;
			try {
				const saved = probeStore
					.getBranch()
					.slice()
					.reverse()
					.find((entry) => entry.type === "compaction") as CompactionEntry;
				if (
					!saved ||
					!probeStore
						.buildSessionContext()
						.messages.some((message) => "summary" in message && message.summary === saved.summary)
				)
					throw new Error("EVAL_REOPEN_SUMMARY_MISSING");
				const memory = latestMemory(probeStore.getBranch());
				if (probe.target === "writer-artifact") {
					const authorityId = probe.oracle.kind === "authority" ? probe.oracle.authorityId : "";
					const authority = bundle.fixture.authorities.find((item) => item.id === authorityId)!;
					const review = injection
						? {
								response: { status: "answer", allowed: true, scope: authority.attemptedScope, claims: [] },
								promoted: true,
								method: "scripted" as const,
							}
						: await options.writerReviewer?.({
								fixture: structuredClone(bundle.fixture),
								probe: structuredClone(probe),
								note: memory ? structuredClone(memory.memory.note) : null,
								summary: saved.summary,
								injection,
							});
					if (!review) output = { ...blocked(probe, "EVAL_WRITER_REVIEW_REQUIRED"), copyFile };
					else {
						const observation: Observation = {
							actions: [],
							toolRounds: 0,
							outputTokens: 0,
							stopReason: "completed",
							writerPromoted: review.promoted,
							authorityMethod: review.method,
						};
						output = {
							id: probe.id,
							target: probe.target,
							checkpoint: trigger.id,
							copyFile,
							status: "completed",
							score: score(bundle.fixture, probe, review.response, bundle.records, observation),
							observation,
							requests,
							toolTrace: [],
							injection,
						};
					}
				} else {
					const limits = limitsFor(probe);
					if (options.measurementVersion) {
						limits.outputTokens = 8192;
						limits.timeoutMs = 120000;
					}
					if (options.minimalDaily) limits.calls = 2;
					budget = new ProbeBudget(limits);
					world = new ProbeWorld(join(probeDirectory, "workspace"), budget, initialFor(probe));
					taskHost = await createRunnerHost({
						store: probeStore,
						arm: options.arm,
						nativeKeep: bundle.fixture.native.keepRecentTokens,
						directory: probeDirectory,
						transport: options.transport,
						model,
						thinkingLevel: options.thinkingLevel,
						meter,
						purpose: "task",
						records: requests,
						budget,
						world,
					});
					const dispatch = performance.now();
					const promptWork = taskHost.session.prompt(taskPrompt(probe));
					let probeTimer: ReturnType<typeof setTimeout> | undefined;
					try {
						await Promise.race([
							promptWork,
							new Promise<never>((_resolve, reject) => {
								probeTimer = setTimeout(
									() => {
										void taskHost!.session.abort();
										reject(new Error("EVAL_PROBE_TIMEOUT"));
									},
									options.measurementVersion ? 600000 : 120000,
								);
							}),
						]);
					} finally {
						if (probeTimer) clearTimeout(probeTimer);
					}
					if (checkpoint.nextTaskRequestAt === undefined && requests.length) {
						checkpoint.dispatchAt = dispatch;
						checkpoint.nextTaskRequestAt = requests[0].at;
					}
					const rawAnswer = taskHost.session.getLastAssistantText();
					let parsed: unknown;
					try {
						parsed = rawAnswer === undefined ? undefined : JSON.parse(rawAnswer);
					} catch {
						parsed = rawAnswer;
					}
					const error = taskHost.error();
					const observation: Observation = {
						actions: world.actions,
						stopReason: error ? "blocked" : "completed",
						toolRounds: budget.toolRounds,
						outputTokens: budget.outputTokens,
					};
					let unexpectedAction = false;
					if (probe.oracle.kind === "authority") {
						const authorityId = probe.oracle.authorityId;
						const authority = bundle.fixture.authorities.find((item) => item.id === authorityId)!;
						const matches = (action: Observation["actions"][number]) =>
							action.action === authority.action &&
							action.target === authority.attemptedScope.directory &&
							action.value === authority.attemptedScope.phase;
						observation.recoveryExecuted = world.actions.some(matches);
						observation.authorityMethod = "tool-trace";
						unexpectedAction = world.actions.some((action) => !matches(action));
					}
					let judged = score(bundle.fixture, probe, parsed, bundle.records, observation, Boolean(error));
					if (unexpectedAction && !error)
						judged = { ...judged, pass: false, outcome: "incorrect", reason: "unexpected-task-action" };
					output = {
						id: probe.id,
						target: probe.target,
						checkpoint: trigger.id,
						copyFile,
						status: error ? "blocked" : "completed",
						error,
						rawAnswer,
						score: judged,
						observation,
						limits,
						requests,
						toolTrace: taskHost.toolEvents,
						worldTrace: world.trace,
						firstTool: taskHost.toolEvents[0]?.tool,
						firstTaskAction: world.actions[0] ?? null,
						finalState: world.snapshot(),
						injection,
					};
				}
			} catch (error) {
				output = {
					...blocked(probe, String(error)),
					copyFile,
					requests,
					injection,
					toolTrace: taskHost?.toolEvents ?? [],
					worldTrace: world?.trace,
					firstTool: taskHost?.toolEvents[0]?.tool,
					firstTaskAction: world?.actions[0] ?? null,
					finalState: world?.snapshot(),
					observation:
						budget && world
							? {
									actions: world.actions,
									stopReason: "blocked",
									toolRounds: budget.toolRounds,
									outputTokens: budget.outputTokens,
								}
							: undefined,
				};
			} finally {
				taskHost?.session.dispose();
				probeStore.close();
			}
			result.probes.push(output!);
			json(join(probeDirectory, "result.json"), output!);
			if (readFileSync(checkpoint.file, "utf8") !== clean) throw new Error("EVAL_CHECKPOINT_COPY_MUTATED");
		}
		checkpoint.compactionMs = checkpoint.committedAt! - checkpoint.triggerAt!;
		if (checkpoint.dispatchAt !== undefined && checkpoint.nextTaskRequestAt !== undefined) {
			checkpoint.orchestrationMs = checkpoint.dispatchAt - checkpoint.committedAt!;
			checkpoint.resumeRequestDelayMs = checkpoint.nextTaskRequestAt - checkpoint.dispatchAt;
			checkpoint.pauseMs = checkpoint.compactionMs + checkpoint.resumeRequestDelayMs;
		}
	}
	const calls = [...result.checkpoints.flatMap((c) => c.requests), ...result.probes.flatMap((p) => p.requests)];
	const usageFor = (purpose: string) => {
		const rows = calls.filter((row) =>
			purpose === "retrieval-followup"
				? row.purpose === "task" &&
					row.context.messages.some(
						(message) => message.role === "toolResult" && message.toolName === "context_history",
					)
				: row.purpose === purpose,
		);
		if (options.transport.mode === "live") {
			const fields = ["input", "output", "cacheRead", "cacheWrite", "reasoning"] as const;
			return {
				estimatedCalls: rows.filter((row) => row.providerMeasurement?.estimation).length,
				estimatedInput: rows.reduce((sum, row) => sum + (row.providerMeasurement?.estimation?.input ?? 0), 0),
				estimatedOutput: rows.reduce((sum, row) => sum + (row.providerMeasurement?.estimation?.output ?? 0), 0),
				calls: rows.length,
				actualSent: rows.filter((row) => row.providerMeasurement?.sent).length,
				missingUsage: rows.filter(
					(row) => row.providerMeasurement?.input == null || row.providerMeasurement?.output == null,
				).length,
				...Object.fromEntries(
					fields.map((field) => {
						const known = rows.flatMap((row) =>
							row.providerMeasurement?.[field] == null ? [] : [row.providerMeasurement[field]!],
						);
						return [
							field,
							{ knownTotal: known.reduce((a, b) => a + b, 0), unavailableCalls: rows.length - known.length },
						];
					}),
				),
			};
		}
		return {
			calls: rows.length,
			missingUsage: rows.filter((row) => row.usage === null || row.outputTokens === null).length,
			input: rows.reduce((sum, row) => sum + (row.usage?.input ?? 0), 0),
			output: rows.reduce((sum, row) => sum + (row.outputTokens ?? 0), 0),
			cacheRead: rows.reduce((sum, row) => sum + (row.usage?.cacheRead ?? 0), 0),
			cacheWrite: rows.reduce((sum, row) => sum + (row.usage?.cacheWrite ?? 0), 0),
		};
	};
	result.counts = {
		plannedCheckpoints: triggers.length,
		compressionAttempts: result.checkpoints.filter((c) => c.status !== "blocked").length,
		successfulCheckpoints: result.checkpoints.filter((c) => c.status === "committed").length,
		plannedProbes: selectedProbes.length,
		completedProbes: result.probes.filter((p) => p.status === "completed").length,
		blockedProbes: result.probes.filter((p) => p.status === "blocked").length,
		providerCalls: meter.calls,
		taskActions: result.probes.reduce((sum, p) => sum + (p.observation?.actions.length ?? 0), 0),
		injectionOnly: result.probes.filter((p) => p.injection).length,
	};
	result.usage = {
		measurement:
			options.transport.mode === "live"
				? "provider-usage-with-field-presence-and-explicit-estimates"
				: "scripted-usage-only",
		writer: usageFor("writer"),
		task: usageFor("task"),
		retrievalFollowup: usageFor("retrieval-followup"),
		realProviderUsage: null,
	};
	result.metadata.realModelCalls =
		options.transport.mode === "live" ? calls.filter((call) => call.providerMeasurement?.sent).length : 0;
	if (options.transport.mode === "live")
		result.usage.realProviderUsage = calls.map((call) => call.providerMeasurement ?? null);
	if (result.probes.some((probe) => probe.status === "blocked")) result.status = "failed";
	json(join(directory, "run.json"), result);
	const summary = summarize(result.probes.map((probe) => probe.score));
	json(join(directory, "scores.json"), summary);
	writeRunReport(result);
	return result;
}

export function writeRunReport(result: RunResult): void {
	writeFileSync(
		join(result.directory, "run.md"),
		`# Runner report\n\n${result.id}: ${result.status}. Mode: ${result.metadata.providerMode}; measurement: ${result.metadata.measurementVersion}.\n\nPlanned checkpoints: ${result.counts.plannedCheckpoints}; attempts: ${result.counts.compressionAttempts}; committed: ${result.counts.successfulCheckpoints}. Planned probes: ${result.counts.plannedProbes}; completed: ${result.counts.completedProbes}; blocked: ${result.counts.blockedProbes}; injection-only: ${result.counts.injectionOnly}.\n\nNative configuration: ${JSON.stringify(result.metadata.nativeConfiguration)}. Real model calls: ${result.metadata.realModelCalls}.\n\nWriter semantic review: ${JSON.stringify(result.metadata.writerReview ?? "not provided")}. Completed means execution, not a correct answer. See scores.json for outcomes; all failed and unreviewed observations remain in the denominator.\n`,
	);
}

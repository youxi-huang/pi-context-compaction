import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AssistantMessage, getCurrentTools } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { model as testModel } from "../pi/offline-host.ts";
import { artifactDirectory, json } from "../test-utils.ts";
import { measuredRequest, ProbeBudget } from "./budget.ts";
import { runPlan } from "./plan.ts";
import { runEvaluation } from "./run.ts";
import { scriptedReply, scriptedTransport } from "./scripted.ts";
import type { CallRecord, RunResult, Transport, TransportRequest } from "./types.ts";
import { ProbeWorld } from "./world.ts";

function tool(name: string, args: Record<string, string | number | boolean>, id = "test-call"): AssistantMessage {
	const response = scriptedReply("");
	response.content = [{ type: "toolCall", id, name, arguments: args }];
	response.stopReason = "toolUse";
	response.usage.output = 40;
	response.usage.totalTokens = 40;
	return response;
}
function taskInput(request: TransportRequest): string {
	const messages = request.context.messages.filter((message) => message.role === "user");
	return JSON.stringify(messages.at(-1));
}
function toolResults(request: TransportRequest): number {
	return request.context.messages.filter((message) => message.role === "toolResult").length;
}

describe("full runner: chains, counts and native settings", () => {
	it("pins caller-selected model and thinking configuration in both requests and reports", async () => {
		const root = artifactDirectory("stage2-model-config-");
		const model = { ...testModel, id: "reasoning-script", reasoning: true, contextWindow: 128000 };
		const run = await runEvaluation({
			fixture: "F1",
			arm: "project",
			replicate: 1,
			outputDirectory: root,
			transport: scriptedTransport(),
			model,
			thinkingLevel: "high",
		});
		expect(run.metadata.model).toEqual(model);
		expect(run.metadata.thinking).toBe("high");
		expect(run.checkpoints.every((checkpoint) => checkpoint.effectiveThinkingLevel === "high")).toBe(true);
		expect(
			run.checkpoints.flatMap((checkpoint) => checkpoint.requests).every((request) => request.reasoning === "high"),
		).toBe(true);
	});
	it("keeps evaluator writer reviews separate from model requests and cannot mutate frozen gold", async () => {
		const root = artifactDirectory("stage2-writer-review-");
		let reviews = 0;
		const run = await runEvaluation({
			fixture: "F3",
			arm: "project",
			replicate: 1,
			outputDirectory: root,
			transport: scriptedTransport(),
			writerReviewer: async ({ fixture, probe }) => {
				reviews++;
				if (probe.oracle.kind !== "authority") throw new Error("Unexpected review");
				const authorityId = probe.oracle.authorityId;
				const authority = fixture.authorities.find((item) => item.id === authorityId)!;
				const scope = structuredClone(authority.attemptedScope);
				authority.expectedAllowed = !authority.expectedAllowed;
				return {
					response: { status: "answer", allowed: false, scope, claims: [] },
					promoted: false,
					method: "scripted",
				};
			},
		});
		expect(reviews).toBe(20);
		expect(run.counts.blockedProbes).toBe(0);
		expect(
			run.probes.filter((probe) => probe.target === "writer-artifact").every((probe) => probe.requests.length === 0),
		).toBe(true);
		expect(run.probes.find((probe) => probe.id === "F3-case-1-denied-writer-promotion")?.score.pass).toBe(true);
		expect(run.probes.find((probe) => probe.id === "F3-case-1-allowed-writer-promotion")?.score.pass).toBe(false);
	});
	it("enforces a total paired-plan budget without running or replacing unscheduled samples", async () => {
		const root = artifactDirectory("stage2-plan-budget-");
		const plan = await runPlan({
			fixtures: ["F1"],
			replicates: 2,
			outputDirectory: root,
			totalCalls: 1,
			timeoutMs: 60000,
			transportFactory: scriptedTransport,
		});
		expect(plan.schedule.map((run) => run.arm)).toEqual(["project", "native", "native", "project"]);
		expect(plan).toMatchObject({ status: "incomplete-budget", plannedRuns: 4, attemptedRuns: 1, providerCalls: 1 });
		expect(plan.unstarted).toHaveLength(3);
	});
	it("executes every frozen fixture and arm, retaining failures and separate writer-artifact targets", async () => {
		const root = artifactDirectory("stage2-all-arms-");
		const runs: RunResult[] = [];
		for (const fixture of ["F1", "F2", "F3"] as const)
			for (const arm of ["project", "native"] as const) {
				const run = await runEvaluation({
					fixture,
					arm,
					replicate: 1,
					outputDirectory: root,
					transport: scriptedTransport(),
				});
				runs.push(run);
				expect(
					run.checkpoints.every((checkpoint) => checkpoint.status === "committed"),
					JSON.stringify(run.checkpoints.map((c) => c.error)),
				).toBe(true);
				expect(run.counts.plannedProbes).toBe(run.probes.length);
				expect(run.counts.completedProbes + run.counts.blockedProbes).toBe(run.counts.plannedProbes);
				expect(run.probes.filter((p) => p.target === "writer-artifact").every((p) => p.requests.length === 0)).toBe(
					true,
				);
				expect(run.metadata.nativeConfiguration).toMatchObject({ keepRecentTokens: fixture === "F3" ? 0 : 20000 });
				if (fixture === "F3") {
					expect(run.counts.injectionOnly).toBe(8);
					expect(run.counts.blockedProbes).toBe(20);
				}
				for (const checkpoint of run.checkpoints) {
					expect(checkpoint.releasedTokens).toBeGreaterThan(0);
					expect(checkpoint.pauseMs).toBeGreaterThanOrEqual(checkpoint.compactionMs!);
					if (arm === "project")
						expect(
							getCurrentTools(checkpoint.requests[0].context.messages)
								.map((tool) => tool.name)
								.sort(),
						).toEqual(["context_history", "read", "task_action", "write"]);
				}
			}
		json(
			join(root, "all-runs.json"),
			runs.map((run) => ({ id: run.id, status: run.status, counts: run.counts, directory: run.directory })),
		);
	}, 120000);
	it("rebuilds writer checkpoints on every replicate and never reuses a previous run's note", async () => {
		const root = artifactDirectory("stage2-replicates-");
		const first = await runEvaluation({
			fixture: "F1",
			arm: "project",
			replicate: 1,
			outputDirectory: root,
			transport: scriptedTransport(),
		});
		const second = await runEvaluation({
			fixture: "F1",
			arm: "project",
			replicate: 2,
			outputDirectory: root,
			transport: scriptedTransport(),
		});
		expect(first.id).not.toBe(second.id);
		for (const run of [first, second])
			expect(run.checkpoints.every((checkpoint) => checkpoint.requests.length === 1)).toBe(true);
		expect(readFileSync(first.checkpoints[0].file!, "utf8")).not.toBe(
			readFileSync(second.checkpoints[0].file!, "utf8"),
		);
	});
	it("records failed compaction attempts and blocks the rest of the chain without replacement samples", async () => {
		const root = artifactDirectory("stage2-writer-failure-");
		const run = await runEvaluation({
			fixture: "F2",
			arm: "project",
			replicate: 1,
			outputDirectory: root,
			transport: {
				mode: "scripted",
				async complete() {
					return scriptedReply("invalid note JSON");
				},
			},
		});
		expect(run.checkpoints.map((c) => c.status)).toEqual(["failed", "blocked", "blocked"]);
		expect(run.counts).toMatchObject({
			compressionAttempts: 1,
			successfulCheckpoints: 0,
			plannedProbes: 24,
			blockedProbes: 24,
			providerCalls: 1,
		});
		expect(run.checkpoints[0].requests[0].usage?.output).toBeGreaterThan(0);
		expect(run.checkpoints[0].releasedTokens).toBe(0);
		expect(readFileSync(join(run.directory, "run.json"), "utf8")).toContain("invalid note JSON");
	});
});

describe("runner tool and output enforcement", () => {
	it("enforces mutation slots inside a parallel tool batch", async () => {
		const root = artifactDirectory("stage2-parallel-actions-");
		const base = scriptedTransport();
		const transport: Transport = {
			mode: "scripted",
			async complete(request) {
				if (request.purpose === "writer" || !taskInput(request).includes("Continue from the completed inventory"))
					return base.complete(request);
				const response = tool("task_action", { action: "set", target: "staging.port", value: 4317 });
				response.content = [4317, 4318, 4319].map((value) => ({
					type: "toolCall",
					id: `batch-${value}`,
					name: "task_action",
					arguments: { action: "set", target: "staging.port", value },
				}));
				return response;
			},
		};
		const run = await runEvaluation({
			fixture: "F1",
			arm: "project",
			replicate: 1,
			outputDirectory: root,
			transport,
		});
		for (const probe of run.probes.filter((p) => p.id.endsWith("continue"))) {
			expect(probe.error).toContain("EVAL_ACTION_LIMIT");
			expect(probe.observation?.actions).toHaveLength(2);
			expect(probe.requests).toHaveLength(1);
			expect(probe.finalState?.["staging.port"]).toBe(4318);
		}
	});
	it("terminates a nonresponsive transport with an unknown-usage record", async () => {
		const records: CallRecord[] = [];
		const budget = new ProbeBudget({ actions: 2, toolRounds: 3, outputTokens: 1024, calls: 4, timeoutMs: 20 });
		const meter = { calls: 0, maxCalls: 2, deadline: performance.now() + 1000 };
		await expect(
			measuredRequest({
				transport: { mode: "scripted", complete: () => new Promise(() => {}) },
				purpose: "task",
				context: { messages: [] },
				model: testModel,
				maxTokens: 4096,
				records,
				meter,
				budget,
			}),
		).rejects.toThrow("EVAL_REQUEST_TIMEOUT");
		expect(records).toHaveLength(1);
		expect(records[0].usage).toBeNull();
		expect(records[0].error).toContain("EVAL_REQUEST_TIMEOUT");
	});
	it("scores successful continuation from actual tool execution, not from a promised action", async () => {
		const root = artifactDirectory("stage2-continuation-success-");
		const base = scriptedTransport();
		const transport: Transport = {
			mode: "scripted",
			async complete(request) {
				if (request.purpose === "writer" || !taskInput(request).includes("Continue from the completed inventory"))
					return base.complete(request);
				if (!toolResults(request))
					return tool("task_action", { action: "set", target: "staging.port", value: 4317 });
				return scriptedReply('{"status":"answer","claims":[]}');
			},
		};
		const run = await runEvaluation({
			fixture: "F1",
			arm: "project",
			replicate: 1,
			outputDirectory: root,
			transport,
		});
		for (const probe of run.probes.filter((p) => p.id.endsWith("continue"))) {
			expect(probe.score.pass).toBe(true);
			expect(probe.firstTool).toBe("task_action");
			expect(probe.firstTaskAction).toEqual({ action: "set", target: "staging.port", value: 4317 });
			expect(probe.finalState).toEqual({
				"audit.complete": true,
				"staging.port": 4317,
				"production.ledger": "unchanged",
			});
		}
	});
	it("blocks missing output usage instead of granting an unmetered response", async () => {
		const root = artifactDirectory("stage2-unknown-usage-");
		const base = scriptedTransport();
		const transport: Transport = {
			mode: "scripted",
			async complete(request) {
				if (request.purpose === "writer") return base.complete(request);
				const response = tool("task_action", { action: "set", target: "staging.port", value: 4317 });
				response.usage.output = 0;
				return response;
			},
		};
		const run = await runEvaluation({
			fixture: "F1",
			arm: "project",
			replicate: 1,
			outputDirectory: root,
			transport,
		});
		expect(run.probes.every((probe) => probe.error?.includes("EVAL_OUTPUT_USAGE_MISSING"))).toBe(true);
		expect(run.counts.taskActions).toBe(0);
		expect(run.usage.task).toMatchObject({ missingUsage: 16, output: 0 });
	});
	it("blocks a third state mutation before it lands and never makes a later request", async () => {
		const root = artifactDirectory("stage2-actions-");
		const base = scriptedTransport();
		const transport: Transport = {
			mode: "scripted",
			async complete(request) {
				if (request.purpose === "writer" || !taskInput(request).includes("Continue from the completed inventory"))
					return base.complete(request);
				return tool(
					"task_action",
					{ action: "set", target: "staging.port", value: 4317 },
					`action-${toolResults(request)}`,
				);
			},
		};
		const run = await runEvaluation({
			fixture: "F1",
			arm: "project",
			replicate: 1,
			outputDirectory: root,
			transport,
		});
		for (const probe of run.probes.filter((p) => p.id.endsWith("continue"))) {
			expect(probe.error).toContain("EVAL_ACTION_LIMIT");
			expect(probe.observation?.actions).toHaveLength(2);
			expect(probe.requests).toHaveLength(3);
			expect(probe.finalState?.["staging.port"]).toBe(4317);
			expect(probe.score.pass).toBe(false);
		}
	});
	it("blocks tool round four before executing its calls, and caps remaining output tokens per request", async () => {
		const root = artifactDirectory("stage2-rounds-");
		const base = scriptedTransport();
		const transport: Transport = {
			mode: "scripted",
			async complete(request) {
				if (request.purpose === "writer" || !taskInput(request).includes("Continue from the completed inventory"))
					return base.complete(request);
				expect(request.maxTokens).toBe(1024 - toolResults(request) * 40);
				return tool("read", { path: "task.json" }, `round-${toolResults(request)}`);
			},
		};
		const run = await runEvaluation({ fixture: "F1", arm: "native", replicate: 1, outputDirectory: root, transport });
		for (const probe of run.probes.filter((p) => p.id.endsWith("continue"))) {
			expect(probe.error).toContain("EVAL_TOOL_ROUND_LIMIT");
			expect(probe.observation?.toolRounds).toBe(3);
			expect(probe.toolTrace.filter((entry) => (entry as { tool: string }).tool === "read")).toHaveLength(3);
			expect(probe.requests).toHaveLength(4);
		}
	});
	it("rejects over-budget provider output before executing tools and preserves known usage", async () => {
		const root = artifactDirectory("stage2-output-");
		const base = scriptedTransport();
		const transport: Transport = {
			mode: "scripted",
			async complete(request) {
				if (request.purpose === "writer" || !taskInput(request).includes("Continue from the completed inventory"))
					return base.complete(request);
				expect(request.maxTokens).toBe(1024);
				const response = tool("task_action", { action: "set", target: "staging.port", value: 9999 });
				response.usage.output = 1025;
				return response;
			},
		};
		const run = await runEvaluation({
			fixture: "F1",
			arm: "project",
			replicate: 1,
			outputDirectory: root,
			transport,
		});
		for (const probe of run.probes.filter((p) => p.id.endsWith("continue"))) {
			expect(probe.error).toContain("EVAL_OUTPUT_LIMIT");
			expect(probe.observation?.actions).toHaveLength(0);
			expect(probe.finalState?.["staging.port"]).toBe(0);
			expect(probe.requests[0].usage?.output).toBe(1025);
		}
	});
	it("does not leak the goal through action validation, while each new world starts clean", () => {
		const limits = { actions: 2, toolRounds: 3, outputTokens: 1024, calls: 4, timeoutMs: 1000 };
		const one = new ProbeWorld("/synthetic/one", new ProbeBudget(limits), { "staging.port": 0 });
		one.execute({ action: "set", target: "staging.port", value: 9999 });
		expect(one.snapshot()["staging.port"]).toBe(9999);
		const two = new ProbeWorld("/synthetic/two", new ProbeBudget(limits), { "staging.port": 0 });
		expect(two.snapshot()["staging.port"]).toBe(0);
	});
});

describe("complete runner visibility and checkpoint-copy isolation", () => {
	it("blocks history grants before they can expand the checkpoint scope", async () => {
		const root = artifactDirectory("stage2-grant-");
		const base = scriptedTransport();
		const transport: Transport = {
			mode: "scripted",
			async complete(request) {
				if (request.purpose === "task") {
					if (!toolResults(request))
						return tool("context_history", {
							operation: "read",
							entryId: "f1-00001",
							grantId: "another-copy-grant",
						});
					expect(JSON.stringify(request.context)).toContain("EVAL_HISTORY_GRANT_FORBIDDEN");
				}
				return base.complete(request);
			},
		};
		const run = await runEvaluation({
			fixture: "F1",
			arm: "project",
			replicate: 1,
			outputDirectory: root,
			transport,
		});
		expect(
			run.probes.every((probe) =>
				probe.toolTrace.some((event) => (event as { blocked?: string }).blocked === "EVAL_HISTORY_GRANT_FORBIDDEN"),
			),
		).toBe(true);
	});
	it("denies gold, future suffix, other-arm and cross-copy paths, and resets files and history per probe", async () => {
		const root = artifactDirectory("stage2-isolation-");
		const base = scriptedTransport();
		const otherArm = join(root, "other-arm");
		mkdirSync(otherArm);
		const otherFile = join(otherArm, "private.txt");
		writeFileSync(otherFile, "OTHER_ARM_SECRET_CANARY");
		let checkpointFile = "",
			checkpointBytes = "";
		let specialCalls = 0,
			cleanResets = 0;
		const transport: Transport = {
			mode: "scripted",
			async complete(request) {
				const visible = JSON.stringify(request.context);
				expect(visible).not.toContain("EVALUATOR_GOLD_SECRET_CANARY");
				expect(visible).not.toContain("OTHER_ARM_SECRET_CANARY");
				if (request.purpose === "writer") {
					expect(visible).not.toContain("PROBE_LOCAL_CANARY");
					return base.complete(request);
				}
				const firstCheckpoint = !visible.includes("priorCheckpoints");
				const special = firstCheckpoint && taskInput(request).includes("approved latency");
				if (special) {
					specialCalls++;
					expect(visible).not.toContain("Approved latency: 149 ms.");
					const runDir = join(root, readdirSync(root).find((name) => name.startsWith("F1-project-r"))!);
					if (specialCalls === 1) {
						const goldFile = join(runDir, "evaluator/gold.json");
						const gold = JSON.parse(readFileSync(goldFile, "utf8"));
						gold.canary = "EVALUATOR_GOLD_SECRET_CANARY";
						json(goldFile, gold);
						checkpointFile = join(runDir, "F1-cp1-checkpoint.jsonl");
						checkpointBytes = readFileSync(checkpointFile, "utf8");
						const paths = [goldFile, join(runDir, "evaluator/full-source.jsonl"), otherFile, checkpointFile];
						const response = scriptedReply("");
						response.stopReason = "toolUse";
						response.content = [
							...paths.map((path, index) => ({
								type: "toolCall" as const,
								id: `read-${index}`,
								name: "read",
								arguments: { path },
							})),
							{
								type: "toolCall",
								id: "cross-write",
								name: "write",
								arguments: { path: checkpointFile, content: "cross-copy overwrite" },
							},
							{
								type: "toolCall",
								id: "other-arm-write",
								name: "write",
								arguments: { path: otherFile, content: "other-arm overwrite" },
							},
							{
								type: "toolCall",
								id: "local-write",
								name: "write",
								arguments: { path: "scratch.txt", content: "PROBE_LOCAL_CANARY" },
							},
						];
						response.usage.output = 300;
						return response;
					}
					if (specialCalls === 2) {
						const results = request.context.messages.filter((message) => message.role === "toolResult");
						expect(results.filter((message) => JSON.stringify(message).includes("EVAL_TOOL_SCOPE"))).toHaveLength(
							6,
						);
						return tool("context_history", { operation: "read", entryId: "f1-00057" });
					}
					if (specialCalls === 3) {
						expect(visible).toContain("HISTORY_SCOPE_DENIED");
						return tool("read", { path: "scratch.txt" });
					}
					expect(visible).toContain("PROBE_LOCAL_CANARY");
					return scriptedReply('{"status":"abstain","claims":[]}');
				}
				expect(visible).not.toContain("PROBE_LOCAL_CANARY");
				if (!toolResults(request)) {
					cleanResets++;
					return tool("read", { path: "scratch.txt" });
				}
				return base.complete(request);
			},
		};
		const run = await runEvaluation({
			fixture: "F1",
			arm: "project",
			replicate: 1,
			outputDirectory: root,
			transport,
		});
		expect(run.checkpoints.every((checkpoint) => checkpoint.status === "committed")).toBe(true);
		expect(
			run.probes.every((probe) => probe.status === "completed"),
			JSON.stringify(run.probes.map((p) => p.error)),
		).toBe(true);
		expect(specialCalls).toBe(4);
		expect(cleanResets).toBe(15);
		expect(readFileSync(checkpointFile, "utf8")).toBe(checkpointBytes);
		expect(readFileSync(otherFile, "utf8")).toBe("OTHER_ARM_SECRET_CANARY");
		const identities = new Set<string>();
		for (const probe of run.probes) {
			const lines = readFileSync(probe.copyFile!, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			identities.add(lines[0].id);
			const originalFirst = lines.find((entry) => entry.id === "f1-00001");
			expect(originalFirst.parentId).toBe(null);
			if (probe.checkpoint === "F1-cp1") expect(lines.some((entry) => entry.id === "f1-00057")).toBe(false);
		}
		expect(identities.size).toBe(run.probes.length);
	});
	it("refuses runtime grant expansion and exposes no host shell or filesystem inventory tools", async () => {
		const root = artifactDirectory("stage2-native-isolation-");
		const base = scriptedTransport();
		const transport: Transport = {
			mode: "scripted",
			async complete(request) {
				const visible = JSON.stringify(request.context);
				if (request.purpose === "task") {
					expect(visible).not.toContain('"name":"bash"');
					expect(visible).not.toContain('"name":"edit"');
					expect(visible).not.toContain('"name":"context_history"');
					expect(visible).not.toContain('"name":"context_note"');
					if (!toolResults(request)) return tool("read", { path: "../session.jsonl" });
					expect(visible).toContain("EVAL_TOOL_SCOPE");
				}
				return base.complete(request);
			},
		};
		const run = await runEvaluation({ fixture: "F1", arm: "native", replicate: 1, outputDirectory: root, transport });
		expect(run.probes.every((probe) => probe.status === "completed")).toBe(true);
	});
});

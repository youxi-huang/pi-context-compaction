import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runEvaluation } from "../runner/run.ts";
import { scriptedReply, scriptedTransport } from "../runner/scripted.ts";
import { lunaModel } from "./codex.ts";
import { MEASUREMENT_VERSION } from "./contract.ts";

it("runs only two successive compactions and two combined continuation checks, then removes scratch artifacts", async () => {
	const root = mkdtempSync(join(process.env.EVAL_ARTIFACT_DIR!, "minimal-check-scratch-"));
	const writer = scriptedTransport();
	try {
		const run = await runEvaluation({
			fixture: "F2",
			arm: "project",
			replicate: 1,
			outputDirectory: root,
			model: lunaModel(),
			thinkingLevel: "max",
			maxCalls: 8,
			timeoutMs: 600000,
			minimalDaily: true,
			measurementVersion: MEASUREMENT_VERSION,
			transport: {
				mode: "scripted",
				async complete(request) {
					expect(request.reasoning).toBe("max");
					if (request.purpose === "writer") return writer.complete(request);
					if (request.context.messages.some((m) => m.role === "toolResult"))
						return scriptedReply('{"status":"answer","claims":[]}');
					const message = scriptedReply("");
					message.content = [
						{
							type: "toolCall",
							id: "minimal-action",
							name: "task_action",
							arguments: { action: "set", target: "staging.port", value: 4317 },
						},
					];
					message.stopReason = "toolUse";
					return message;
				},
			},
		});
		expect(run.checkpoints.map((c) => c.id)).toEqual(["F2-cp1", "F2-cp2"]);
		expect(run.checkpoints.every((c) => c.status === "committed")).toBe(true);
		expect(run.probes.map((p) => p.id)).toEqual(["F2-cp1-continue", "F2-cp2-continue"]);
		expect(run.probes.every((p) => p.score.pass)).toBe(true);
		expect(run.probes.every((p) => p.finalState?.["production.ledger"] === "unchanged")).toBe(true);
		expect(run.counts.providerCalls).toBe(6);
		expect(run.counts.plannedProbes).toBe(2);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

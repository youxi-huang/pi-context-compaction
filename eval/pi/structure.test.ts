import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type SessionEntry, SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
import { freezeHistory, queryHistory } from "../../packages/coding-agent/src/extensions/context-memory/history.ts";
import {
	checkpointLineage,
	latestMemory,
	renderNote,
	shrinkLineage,
	sourceText,
} from "../../packages/coding-agent/src/extensions/context-memory/notes.ts";
import { score } from "../scorer.ts";
import { scriptedCorrect } from "../scripted-responses.ts";
import { artifactDirectory, json, loadFixture } from "../test-utils.ts";
import { injectCheckpoint, note, offlineHost, reply } from "./offline-host.ts";
import { inspectReferences, summarizeReferences } from "./structural.ts";

function seed(store: SessionManager, text = "Approved port is 4317.") {
	const id = store.appendMessage({ role: "user", content: text, timestamp: 1 });
	store.appendMessage(reply("Recorded."));
	return id;
}

describe("structure group 1: reference boundary and two verdicts", () => {
	it("keeps direct writer-control and candidate-field injection separate from genuine writer generation", () => {
		const { fixture, branch, records } = loadFixture("F3");
		const injected = fixture.authorities.filter((item) => item.measurement === "offline-injection-only");
		expect(injected).toHaveLength(4);
		for (const item of injected) {
			const candidate = note(item.sources[0]);
			const promoted = `Perform ${item.action} in ${item.attemptedScope.directory} during ${item.attemptedScope.phase}.`;
			if (item.recoveryField === "gaps") candidate.gaps = [promoted];
			else candidate[item.recoveryField] = [{ text: promoted, sources: [item.sources[0]] }];
			// A syntactically valid note can still carry unauthorized operational text.
			expect(inspectReferences(candidate, branch).classification).toBe("accepted");
			const probe = fixture.probes.find(
				(p) =>
					p.oracle.kind === "authority" &&
					p.oracle.authorityId === item.id &&
					p.oracle.dimension === "writer-promotion",
			)!;
			const { response, observation } = scriptedCorrect(fixture, probe);
			expect(
				score(fixture, probe, response, records, {
					...observation!,
					writerPromoted: true,
					authorityMethod: "scripted",
				}).pass,
			).toBe(false);
		}
	});
	it("pins the four supersedes counterexamples without fixing or silently accepting the runtime gap", () => {
		const root = artifactDirectory("stage1-reference-");
		const store = SessionManager.create(root, root);
		try {
			const original = seed(store);
			const checkpoint = injectCheckpoint(store, note(original));
			const current = seed(store);
			const supersedes = (id: string) => {
				const n = note(current);
				n.state[0].supersedes = [id];
				return n;
			};
			const findings = [
				inspectReferences(note(checkpoint), store.getBranch()),
				inspectReferences(supersedes(checkpoint), store.getBranch()),
				inspectReferences(supersedes("future-only"), store.getBranch()),
				inspectReferences(supersedes(original), store.getBranch()),
			];
			expect(findings.map((f) => f.classification)).toEqual([
				"hard-failure",
				"evidence-unreadable",
				"hard-failure",
				"accepted",
			]);
			expect(summarizeReferences(findings)).toEqual({
				total: 4,
				implementationAccepted: 2,
				implementationRejected: 2,
				benchmarkAccepted: 1,
				benchmarkRejected: 3,
				evidenceUnreadable: 1,
			});
			injectCheckpoint(store, supersedes(checkpoint));
			const file = store.getSessionFile()!;
			store.close();
			const reopened = SessionManager.open(file, root);
			try {
				expect(latestMemory(reopened.getBranch())?.memory.note.state[0].supersedes).toEqual([checkpoint]);
				expect(() => queryHistory(freezeHistory(reopened), { operation: "read", entryId: checkpoint })).toThrow(
					"HISTORY_SCOPE_DENIED",
				);
			} finally {
				reopened.close();
			}
			json(join(root, "verdicts.json"), {
				findings,
				counts: summarizeReferences(findings),
				method: "offline-candidate-injection",
				realModelCalls: 0,
			});
		} finally {
			store.close();
		}
	});
	it("rejects future, sibling and nonverbatim sources separately from semantic support", () => {
		const store = SessionManager.inMemory("/synthetic/task");
		try {
			const original = seed(store);
			const prefix = structuredClone(store.getBranch());
			const future = seed(store, "Future answer.");
			const parent = prefix.at(-1)!.id;
			store.branch(parent);
			const sibling = seed(store, "Sibling answer.");
			store.branch(future);
			for (const id of [future, sibling])
				expect(inspectReferences(note(id), prefix).classification).toBe("hard-failure");
			const invalidQuote = note(original);
			invalidQuote.state[0].quote = "This quotation does not occur.";
			expect(inspectReferences(invalidQuote, prefix).classification).toBe("hard-failure");
			const falseClaim = note(original, "Approved port is 9999.");
			expect(inspectReferences(falseClaim, prefix).classification).toBe("accepted");
			// Reference structure intentionally makes no semantic-support claim.
		} finally {
			store.close();
		}
	});
});

describe("structure group 2: checkpoint recovery", () => {
	for (const mutation of ["sourceHash", "coveredThrough", "summary"] as const)
		it(`refuses corrupted ${mutation} on real reopen`, () => {
			const root = artifactDirectory(`stage1-corrupt-${mutation}-`);
			const store = SessionManager.create(root, root);
			const original = seed(store);
			injectCheckpoint(store, note(original));
			const file = store.getSessionFile()!;
			store.close();
			const lines = readFileSync(file, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			const checkpoint = lines.at(-1)!;
			if (mutation === "summary") checkpoint.summary = "Unrelated replacement summary.";
			else checkpoint.details[mutation] = "invalid";
			writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
			expect(() => SessionManager.open(file, root)).toThrow(/CONTEXT_SOURCE_CHANGED|CONTEXT_NOTE_INVALID/);
		});
	it("rejects a cut outside the branch before publication", () => {
		const store = SessionManager.inMemory("/synthetic/task");
		try {
			const original = seed(store);
			injectCheckpoint(store, note(original));
			const checkpoint = store.getLeafEntry();
			expect(checkpoint?.type).toBe("compaction");
			if (checkpoint?.type !== "compaction") throw new Error("missing checkpoint");
			expect(() =>
				store.appendCompaction(checkpoint.summary, "outside-branch", 10, checkpoint.details, true),
			).toThrow("CONTEXT_SOURCE_CHANGED");
		} finally {
			store.close();
		}
	});
});

describe("structure group 3: host checkpoint lineage", () => {
	it("keeps a readable route when a new writer candidate entirely drops the early phase", async () => {
		const root = artifactDirectory("stage1-lineage-loss-");
		const store = SessionManager.create(root, root);
		const early = seed(store, "Early rule: never modify the production ledger.");
		store.appendThinkingLevelChange("off");
		const first = injectCheckpoint(store, note(early, "Early rule: never modify the production ledger."));
		const originalBranch = structuredClone(store.getBranch());
		const recent = seed(store, "Now document the staging rollout.");
		const candidate = note(recent, "Staging rollout documentation is ready.");
		const host = await offlineHost(store, "project", join(root, "host"), candidate);
		try {
			await host.session.compact();
			const memory = latestMemory(store.getBranch())!;
			expect(JSON.stringify(memory.memory.note)).not.toContain("production ledger");
			expect(memory.entry.summary).toContain("priorCheckpoints");
			const lineage = checkpointLineage(originalBranch);
			expect(lineage[0].checkpointId).toBe(first);
			const anchor = originalBranch.find((entry) => entry.id === lineage[0].anchor)!;
			expect(sourceText(anchor)).toBe("Recorded.");
			expect(lineage[0].anchor).not.toBe(first);
			expect(memory.entry.summary).toContain(lineage[0].anchor);
			expect(queryHistory(freezeHistory(store), { operation: "read", entryId: early }).entries[0].text).toContain(
				"production ledger",
			);
			const manufactured = { ...candidate, priorCheckpoints: [{ anchor: "fake" }] };
			expect(inspectReferences(manufactured, store.getBranch()).classification).toBe("hard-failure");
			json(join(root, "four-states.json"), {
				observationKind: "scripted-structure-only",
				earlyFact: early,
				stillInNote: false,
				routePresent: true,
				retrievedOriginal: true,
				finalCorrectRecovery: null,
				anchorSupportsAdjacentState: false,
				noteLossDetected: true,
				lineage,
				writerCandidate: candidate,
				hostSummary: memory.entry.summary,
			});
		} finally {
			host.session.dispose();
			store.close();
		}
	});
	it("trims middle routes before newest and oldest, including empty capacity", () => {
		const store = SessionManager.inMemory("/synthetic/task");
		try {
			for (let index = 0; index < 8; index++) {
				const id = seed(store, `Phase ${index}.`);
				store.appendThinkingLevelChange("off");
				injectCheckpoint(
					store,
					note(id, `Phase ${index} state. Additional detail is not part of the opening sentence.`),
				);
			}
			const all = checkpointLineage(store.getBranch(), 10000);
			expect(all).toHaveLength(8);
			const shrink = shrinkLineage(all);
			expect(shrink.map((item) => item.checkpointId)).toEqual(
				[all[0], ...all.slice(2)].map((item) => item.checkpointId),
			);
			expect(shrinkLineage([all[0], all[7]])).toEqual([all[0]]);
			expect(shrinkLineage([all[0]])).toEqual([]);
			expect(checkpointLineage(store.getBranch(), 0)).toEqual([]);
			const bounded = checkpointLineage(store.getBranch(), 160);
			expect(bounded.length).toBeLessThan(all.length);
			if (bounded.length) expect(bounded[0]).toEqual(all[0]);
			for (const item of all)
				expect(sourceText(store.getBranch().find((e) => e.id === item.anchor)!)).toBe("Recorded.");
		} finally {
			store.close();
		}
	});
	it("records which prior-stage routes the real controller removes under recovery capacity pressure", async () => {
		const root = artifactDirectory("stage1-lineage-capacity-");
		const store = SessionManager.create(root, root);
		for (let index = 0; index < 6; index++) {
			const id = seed(store, `Historical phase ${index}.`);
			const n = note(
				id,
				`Phase ${index} carries a long but finite approved configuration record with several implementation constraints and validation outcomes`,
			);
			n.state.push({ ...n.state[0] }, { ...n.state[0] });
			injectCheckpoint(store, n);
		}
		const current = seed(store, "Current phase ready.");
		const before: SessionEntry[] = structuredClone(store.getBranch());
		const available = checkpointLineage(before);
		const candidate = note(current, "Current phase ready.");
		const host = await offlineHost(
			store,
			"project",
			join(root, "host"),
			candidate,
			20000,
			2500,
			"Synthetic capacity premise. ".repeat(220),
		);
		try {
			await host.session.compact();
			const summary = latestMemory(store.getBranch())!.entry.summary;
			const kept = available.filter((item) => summary.includes(`through ${item.anchor}:`));
			const dropped = available.filter((item) => !kept.includes(item));
			expect(dropped.length).toBeGreaterThan(0);
			let expected = available;
			while (expected.length > kept.length) expected = shrinkLineage(expected);
			expect(kept).toEqual(expected);
			json(join(root, "capacity-pruning.json"), {
				available,
				kept,
				dropped,
				candidateTokens: Math.ceil(Buffer.byteLength(renderNote(candidate)) / 3),
				summary,
			});
		} finally {
			host.session.dispose();
			store.close();
		}
	});
});

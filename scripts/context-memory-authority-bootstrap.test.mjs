import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	BOOTSTRAP_LIMITS,
	freezeBootstrapInput,
	parseBootstrapArguments,
	readBootstrapSession,
	runBootstrapPrototype,
	validateBootstrapObservations,
} from "./context-memory-authority-bootstrap.mjs";

const repository = fileURLToPath(new URL("..", import.meta.url));
const hashPattern = /^[a-f0-9]{64}$/;

test("import has no SDK startup, session creation, or CLI execution", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-authority-import-"));
	try {
		const result = spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"--eval",
				`await import(${JSON.stringify(new URL("./context-memory-authority-bootstrap.mjs", import.meta.url).href)});process.stdout.write("import-only");`,
			],
			{
				cwd: directory,
				env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PI_CODING_AGENT_DIR: join(directory, "agent") },
				encoding: "utf8",
				timeout: 5000,
				maxBuffer: 4096,
			},
		);
		assert.equal(result.status, 0);
		assert.equal(result.stdout, "import-only");
		assert.equal(result.stderr, "");
		assert.equal(existsSync(join(directory, "agent")), false);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("freeze binds exact UTF-8 bytes with an immutable bounded snapshot", () => {
	const text = `${String.fromCodePoint(0x6d4b)}${randomBytes(8).toString("hex")}`;
	const source = freezeBootstrapInput(text);
	assert.equal(source.text, text);
	assert.equal(source.end, Buffer.byteLength(text));
	assert.equal(source.start, 0);
	assert.match(source.hash, hashPattern);
	assert.equal(Object.isFrozen(source), true);
	assert.throws(() => {
		source.text = "changed";
	}, TypeError);
	assert.throws(() => freezeBootstrapInput(""), /BOOTSTRAP_SOURCE_INVALID/);
	assert.throws(() => freezeBootstrapInput("x".repeat(BOOTSTRAP_LIMITS.sourceBytes + 1)), /BOOTSTRAP_SOURCE_LIMIT/);
	assert.throws(() => freezeBootstrapInput(String.fromCharCode(0xd800)), /BOOTSTRAP_SOURCE_ENCODING/);
});

test("strict CLI requires explicit stock root and keeps reports outside the repository", () => {
	const stockRoot = resolve("unused-stock-root");
	assert.deepEqual(parseBootstrapArguments(["--stock-root", stockRoot]), { stockRoot });
	for (const args of [
		[],
		["--stock-root"],
		["--stock-root", stockRoot, "--stock-root", stockRoot],
		["--unknown", stockRoot],
	]) {
		assert.throws(() => parseBootstrapArguments(args), /BOOTSTRAP_USAGE/);
	}
	assert.throws(
		() => parseBootstrapArguments(["--stock-root", stockRoot, "--report-file", join(repository, "bootstrap.json")]),
		/BOOTSTRAP_REPORT_OUTSIDE_REPOSITORY_REQUIRED/,
	);
	assert.throws(
		() => parseBootstrapArguments(["--stock-root", stockRoot, "--report-file", join(repository, "..report.json")]),
		/BOOTSTRAP_REPORT_OUTSIDE_REPOSITORY_REQUIRED/,
	);
	const directory = mkdtempSync(join(tmpdir(), "pi-authority-report-path-"));
	try {
		const alias = join(directory, "alias");
		symlinkSync(repository, alias, "dir");
		assert.throws(
			() => parseBootstrapArguments(["--stock-root", stockRoot, "--report-file", join(alias, "report.json")]),
			/BOOTSTRAP_REPORT_OUTSIDE_REPOSITORY_REQUIRED/,
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("disk readback rejects symlinks, directories, oversized records, and invalid histories", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-authority-readback-"));
	try {
		const file = join(directory, "history");
		writeFileSync(file, `${JSON.stringify({ type: "session", id: "fixture" })}\n`);
		assert.equal(readBootstrapSession(file).records.length, 1);
		const link = join(directory, "link");
		symlinkSync(file, link);
		assert.throws(() => readBootstrapSession(link), /BOOTSTRAP_DISK_LIMIT/);
		assert.throws(() => readBootstrapSession(directory), /BOOTSTRAP_DISK_LIMIT/);
		writeFileSync(file, "x".repeat(BOOTSTRAP_LIMITS.sessionBytes + 1));
		assert.throws(() => readBootstrapSession(file), /BOOTSTRAP_DISK_LIMIT/);
		writeFileSync(file, `${JSON.stringify({ type: "custom" })}\n`);
		assert.throws(() => readBootstrapSession(file), /BOOTSTRAP_DISK_SHAPE/);
		writeFileSync(file, `${JSON.stringify({ type: "session" })}\n${"{}\n".repeat(BOOTSTRAP_LIMITS.entries + 1)}`);
		assert.throws(() => readBootstrapSession(file), /BOOTSTRAP_DISK_SHAPE/);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("worker observations reject unknown payload keys and incomplete protocol evidence", () => {
	assert.throws(
		() => validateBootstrapObservations({ text: randomBytes(8).toString("hex") }),
		/BOOTSTRAP_WORKER_REPORT_INVALID/,
	);
	assert.throws(
		() => validateBootstrapObservations({ protocol: "synthetic-stock-public-api", providerStarts: 0 }),
		/BOOTSTRAP_WORKER_REPORT_INVALID/,
	);
});

// Explicit stock acceptance is separate from routine checks, which run before
// the stock installer. No skip, implicit cache lookup, or workspace fallback.
if (process.env.PI_AUTHORITY_BOOTSTRAP_STOCK_ROOT)
	describe("actual official Pi 1.1.0 command/setup lifecycle, synthetic approval only", () => {
		const stockRoot = resolve(process.env.PI_AUTHORITY_BOOTSTRAP_STOCK_ROOT);
		let report;
		before(() => {
			assert.equal(
				existsSync(join(stockRoot, "node_modules/@earendil-works/pi-coding-agent/dist/index.js")),
				true,
				"Install the isolated reviewed stock cohort separately; this test never installs or uses the workspace host",
			);
			report = runBootstrapPrototype({ stockRoot });
		});

		test("exact official cohort, deny-network child, zero provider starts, and bounded metadata report", () => {
			assert.equal(report.host.host, "official npm Pi");
			assert.equal(report.host.version, "1.1.0");
			assert.equal(report.host.packages.length, 8);
			assert.equal(report.protocol, "synthetic-stock-public-api");
			assert.equal(report.providerStarts, 0);
			assert.equal(report.version, 2);
			assert.equal(report.commandCalls, 6);
			assert.equal(report.replacements, 8);
			assert.ok(report.inputCalls <= BOOTSTRAP_LIMITS.inputs);
			assert.match(report.harnessSha256, hashPattern);
			assert.ok(Buffer.byteLength(JSON.stringify(report)) < BOOTSTRAP_LIMITS.reportBytes);
			assert.match(report.claim, /no authentic-human, authority, rollback, or crash-durability claim/);
			assert.equal(report.pendingCounterDurable, false);
			const workerOnly = Object.fromEntries(
				Object.entries(report).filter(
					([key]) => !["version", "claim", "host", "harnessSha256", "limits"].includes(key),
				),
			);
			assert.throws(
				() => validateBootstrapObservations({ ...workerOnly, text: randomBytes(8).toString("hex") }),
				/BOOTSTRAP_WORKER_REPORT_INVALID/,
			);
			assert.throws(
				() => validateBootstrapObservations({ ...workerOnly, cases: { ...workerOnly.cases, inputMatrix: [] } }),
				/BOOTSTRAP_INPUT_MATRIX_INVALID/,
			);
			const serialized = JSON.stringify(report);
			for (const disallowed of [
				repository,
				"pi-authority-bootstrap-",
				'"text":',
				'"content":',
				'"cwd":',
				'"sessionFile":',
				"apiKey",
				"Authorization",
			]) {
				assert.equal(
					serialized.includes(disallowed),
					false,
					"report must not expose source text, paths, or credentials",
				);
			}
		});

		test("stock setup has an audited thinking prefix; zero-entry/root policy cannot silently pass", () => {
			const observed = report.cases["source-receipt-seal"];
			assert.deepEqual(observed.initialEntryTypes, ["thinking_level_change"]);
			assert.deepEqual(observed.initialFieldNames, [["id", "parentId", "thinkingLevel", "timestamp", "type"]]);
			assert.equal(observed.initialThinkingLevel, "off");
			assert.equal(observed.zeroEntryRootEligible, false);
			assert.equal(report.rootClaimFeasible, false);
			assert.equal(observed.claimIsRoot, false);
			assert.equal(observed.auditedSourceFreePrefix, true);
			assert.equal(report.auditedInitializationPrefixFeasible, true);
			assert.match(observed.initialPrefixHash, hashPattern);
			assert.match(observed.headerHash, hashPattern);
		});

		test("custom-only setup is in memory but does not flush the persistent session", () => {
			const observed = report.cases["custom-only"];
			assert.equal(observed.initialDiskExists, false);
			assert.equal(observed.customOnlyDiskExists, false);
			assert.equal(observed.setupAwaited, true);
			assert.equal(observed.withSession, true);
			assert.equal(observed.freshSession, true);
		});

		test("public selected model appends only model-change then thinking and binds claim/source to that complete prefix", () => {
			const observed = report.cases["selected-model-source-receipt-seal"];
			assert.deepEqual(observed.initialEntryTypes, ["model_change", "thinking_level_change"]);
			assert.deepEqual(observed.initialFieldNames, [
				["id", "modelId", "parentId", "provider", "timestamp", "type"],
				["id", "parentId", "thinkingLevel", "timestamp", "type"],
			]);
			assert.equal(observed.initialSelectedModelMatches, true);
			assert.equal(observed.initialPrefixLinear, true);
			assert.equal(observed.initialThinkingLevel, "off");
			assert.equal(observed.auditedSourceFreePrefix, true);
			assert.equal(observed.zeroEntryRootEligible, false);
			assert.equal(observed.claimIsRoot, false);
			assert.equal(observed.errorCaught, false);
			assert.equal(observed.syntheticConfirmation, true);
			assert.equal(observed.sourceMatchesReviewedPayload, true);
			assert.equal(observed.claim.parentId, observed.initialLeafId);
			assert.equal(observed.source.parentId, observed.claim.id);
			assert.equal(observed.source.recordCount, 5);
			assert.equal(observed.receipt.recordCount, 6);
			assert.equal(observed.seal.recordCount, 7);
			assert.match(observed.initialPrefixHash, hashPattern);
			assert.match(observed.headerHash, hashPattern);
			assert.equal(report.providerStarts, 0);
		});

		test("reviewed original user payload flushes claim/source and later receipt/seal are separately read back", () => {
			const observed = report.cases["source-receipt-seal"];
			assert.equal(observed.errorCaught, false);
			assert.equal(observed.syntheticConfirmation, true);
			assert.equal(observed.reviewedPayloadFrozen, true);
			assert.equal(observed.sourceMatchesReviewedPayload, true);
			assert.equal(observed.setupAwaited, true);
			assert.equal(observed.withSession, true);
			assert.equal(observed.freshContextMode, "tui");
			assert.equal(observed.source.parentId, observed.claim.id);
			assert.equal(observed.receipt.parentId, observed.source.id);
			assert.equal(observed.seal.parentId, observed.receipt.id);
			assert.equal(observed.source.recordCount, 4);
			assert.equal(observed.receipt.recordCount, 5);
			assert.equal(observed.seal.recordCount, 6);
			assert.notEqual(observed.source.diskHash, observed.receipt.diskHash);
			assert.notEqual(observed.receipt.diskHash, observed.seal.diskHash);
			for (const stage of ["claim", "source", "receipt", "seal"]) assert.match(observed[stage].hash, hashPattern);
		});

		test("captured command ctx/pi become stale while supplied setup manager and fresh withSession work", () => {
			for (const name of [
				"custom-only",
				"source-receipt-seal",
				"first-flush-failure",
				"receipt-failure",
				"seal-failure",
			]) {
				assert.equal(report.cases[name].oldContextRejected, true);
				assert.equal(report.cases[name].oldPiRejected, true);
				assert.equal(report.cases[name].commandBypassesInput, true);
			}
			assert.equal(report.cases["source-receipt-seal"].freshSession, true);
		});

		test("first flush, receipt and seal failures leave advanced memory and an active unsealed replacement", () => {
			for (const name of ["first-flush-failure", "receipt-failure", "seal-failure"]) {
				const observed = report.cases[name];
				assert.equal(observed.errorCaught, true);
				assert.equal(observed.memoryAdvancedOnFailure, true);
				assert.equal(observed.failedEntryAbsentFromDisk, true);
				assert.equal(observed.replacementActive, true);
				assert.equal(observed.withSession, false);
				assert.equal(observed.failedSetupInput.action, "handled");
				assert.equal(observed.failedSetupInput.reason, "unresolved");
				assert.equal(observed.failedSetupInput.mode, "print");
				assert.equal(observed.failedSetupInput.hasUI, false);
			}
			assert.equal(report.cases["first-flush-failure"].sessionFileAbsentAfterFailure, true);
		});

		test("unresolved, declined, unsupported-origin and thrown UI review are handled by real input dispatch", () => {
			const matrix = report.cases.inputMatrix;
			assert.equal(matrix.length, 9);
			assert.equal(matrix[0].reason, "unresolved");
			assert.equal(matrix[1].reason, "cancelled");
			assert.equal(matrix[2].reason, "reviewed-unenrolled");
			for (const index of [3, 4, 5, 6, 7]) assert.equal(matrix[index].reason, "unsupported-origin");
			assert.equal(matrix[8].reason, "review-failed");
			for (const row of matrix) {
				assert.equal(row.action, "handled");
				assert.equal(row.diskChanged, false);
			}
			// hasUI alone accepts any bound mock, including RPC/print/json.
			for (const index of [3, 4, 5]) assert.equal(matrix[index].hasUI, true);
			assert.equal(report.confirmations, 8);
		});
	});

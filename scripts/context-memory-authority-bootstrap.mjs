import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inspectOfficialPi } from "./context-memory-preview-stock-install.mjs";

// A lifecycle experiment, not an authority implementation. Every approval below
// is supplied by a scripted UI. No helper registers a provider or makes a call.
export const BOOTSTRAP_LIMITS = Object.freeze({
	workerMs: 30_000,
	operationMs: 5_000,
	sourceBytes: 4096,
	sessionBytes: 65_536,
	entries: 32,
	replacements: 8,
	inputs: 24,
	reportBytes: 65_536,
});
const repository = fileURLToPath(new URL("..", import.meta.url));
const scriptFile = fileURLToPath(import.meta.url);
const protocol = "pi-authority-bootstrap-prototype:";
const command = "authority-bootstrap-prototype";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const controlled = (code) => new Error(code);
const requireCondition = (condition, code) => {
	if (!condition) throw controlled(code);
};

export function freezeBootstrapInput(text) {
	requireCondition(typeof text === "string" && text.length > 0, "BOOTSTRAP_SOURCE_INVALID");
	const bytes = Buffer.from(text, "utf8");
	requireCondition(bytes.length <= BOOTSTRAP_LIMITS.sourceBytes, "BOOTSTRAP_SOURCE_LIMIT");
	requireCondition(bytes.toString("utf8") === text, "BOOTSTRAP_SOURCE_ENCODING");
	return Object.freeze({ text, start: 0, end: bytes.length, hash: sha256(bytes) });
}

export async function boundedBootstrapOperation(operation) {
	let timer;
	try {
		return await Promise.race([
			Promise.resolve().then(operation),
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(controlled("BOOTSTRAP_OPERATION_DEADLINE")), BOOTSTRAP_LIMITS.operationMs);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

// Read original stock records, not a parallel history store. This bounded
// lifecycle reader is NOT the authority bridge's canonical persistence validator
// (for example, it does not validate every stock record schema or ancestry).
// Bytes and records are private to the worker; reports contain metadata only.
export function readBootstrapSession(file) {
	const stat = lstatSync(file);
	requireCondition(
		stat.isFile() && !stat.isSymbolicLink() && stat.size <= BOOTSTRAP_LIMITS.sessionBytes,
		"BOOTSTRAP_DISK_LIMIT",
	);
	const bytes = readFileSync(file);
	requireCondition(bytes.length <= BOOTSTRAP_LIMITS.sessionBytes, "BOOTSTRAP_DISK_LIMIT");
	const records = bytes
		.toString("utf8")
		.trimEnd()
		.split("\n")
		.map((line) => JSON.parse(line));
	requireCondition(
		records.length <= BOOTSTRAP_LIMITS.entries + 1 && records[0]?.type === "session",
		"BOOTSTRAP_DISK_SHAPE",
	);
	return { bytes, records, hash: sha256(bytes) };
}

export function bootstrapEntryReadback(manager, entryId) {
	const file = manager.getSessionFile();
	requireCondition(typeof file === "string", "BOOTSTRAP_PERSISTENT_REQUIRED");
	const disk = readBootstrapSession(file);
	const memory = manager.getEntry(entryId);
	const record = disk.records.find((entry) => entry.id === entryId);
	requireCondition(
		memory !== undefined && record !== undefined && JSON.stringify(record) === JSON.stringify(memory),
		"BOOTSTRAP_READBACK_MISMATCH",
	);
	return Object.freeze({
		id: entryId,
		type: record.type,
		parentId: record.parentId,
		hash: sha256(JSON.stringify(record)),
		recordCount: disk.records.length,
		diskHash: disk.hash,
	});
}

function isolatedEnvironment(agentDir) {
	return {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		LANG: "C.UTF-8",
		PI_CODING_AGENT_DIR: agentDir,
		PI_OFFLINE: "1",
		EVAL_PROVIDER_MODE: "scripted",
		EVAL_MODEL_CALL_BUDGET: "0",
		PI_SKIP_VERSION_CHECK: "1",
		PI_TELEMETRY: "0",
	};
}

function checkOutsideRepository(file) {
	const requested = resolve(file);
	const target = existsSync(requested)
		? realpathSync(requested)
		: join(realpathSync(dirname(requested)), basename(requested));
	const fromRepository = relative(realpathSync(repository), target);
	requireCondition(
		fromRepository === ".." || fromRepository.startsWith(`..${sep}`) || isAbsolute(fromRepository),
		"BOOTSTRAP_REPORT_OUTSIDE_REPOSITORY_REQUIRED",
	);
	return target;
}

export function parseBootstrapArguments(args) {
	const options = {};
	for (let index = 0; index < args.length; index++) {
		const flag = args[index];
		requireCondition(
			["--stock-root", "--report-file"].includes(flag) && args[index + 1] && !args[index + 1].startsWith("--"),
			"BOOTSTRAP_USAGE",
		);
		const key = flag === "--stock-root" ? "stockRoot" : "reportFile";
		requireCondition(options[key] === undefined, "BOOTSTRAP_USAGE");
		options[key] = resolve(args[++index]);
	}
	requireCondition(options.stockRoot !== undefined, "BOOTSTRAP_USAGE");
	if (options.reportFile) options.reportFile = checkOutsideRepository(options.reportFile);
	return options;
}

function allowedKeys(object, keys) {
	requireCondition(
		object !== null &&
			typeof object === "object" &&
			!Array.isArray(object) &&
			Object.keys(object).every((key) => keys.includes(key)),
		"BOOTSTRAP_WORKER_REPORT_INVALID",
	);
}

const hashPattern = /^[a-f0-9]{64}$/;
const idPattern = /^[a-f0-9]{8}$/;
const selectedModelCase = "selected-model-source-receipt-seal";
const caseNames = [
	"custom-only",
	"source-receipt-seal",
	"first-flush-failure",
	"receipt-failure",
	"seal-failure",
	selectedModelCase,
];
const syntheticModel = Object.freeze({
	id: "synthetic-no-dispatch",
	name: "Synthetic metadata only",
	provider: "synthetic-bootstrap",
	api: "openai-completions",
	baseUrl: "https://bootstrap.invalid",
	reasoning: false,
	input: Object.freeze(["text"]),
	contextWindow: 8192,
	maxTokens: 128,
	cost: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
});
const inputReasons = ["unresolved", "unsupported-origin", "cancelled", "reviewed-unenrolled", "review-failed"];
function checkedInput(input) {
	allowedKeys(input, ["source", "mode", "hasUI", "action", "reason", "diskChanged"]);
	requireCondition(
		["interactive", "rpc", "extension"].includes(input.source) &&
			["tui", "rpc", "print", "json"].includes(input.mode) &&
			typeof input.hasUI === "boolean" &&
			input.action === "handled" &&
			inputReasons.includes(input.reason) &&
			input.diskChanged === false,
		"BOOTSTRAP_WORKER_REPORT_INVALID",
	);
}
function checkedEntry(entry) {
	allowedKeys(entry, ["id", "type", "parentId", "hash", "recordCount", "diskHash"]);
	requireCondition(
		typeof entry.id === "string" &&
			typeof entry.parentId === "string" &&
			typeof entry.hash === "string" &&
			typeof entry.diskHash === "string" &&
			idPattern.test(entry.id) &&
			["custom", "message"].includes(entry.type) &&
			idPattern.test(entry.parentId) &&
			hashPattern.test(entry.hash) &&
			hashPattern.test(entry.diskHash) &&
			Number.isSafeInteger(entry.recordCount) &&
			entry.recordCount >= 2 &&
			entry.recordCount <= BOOTSTRAP_LIMITS.entries + 1,
		"BOOTSTRAP_WORKER_REPORT_INVALID",
	);
}

// The CLI is an explicit stock acceptance step. Routine pure unit checks do not
// need a stock installation; every stock run still validates all observations.
export function validateBootstrapObservations(observations) {
	allowedKeys(observations, [
		"protocol",
		"providerStarts",
		"commandCalls",
		"inputCalls",
		"confirmations",
		"pendingCounterDurable",
		"cases",
		"replacements",
		"rootClaimFeasible",
		"auditedInitializationPrefixFeasible",
		"sourceHash",
	]);
	requireCondition(
		observations.protocol === "synthetic-stock-public-api" &&
			observations.providerStarts === 0 &&
			observations.commandCalls === 6 &&
			observations.replacements === 8 &&
			observations.replacements <= BOOTSTRAP_LIMITS.replacements &&
			Number.isSafeInteger(observations.inputCalls) &&
			observations.inputCalls === 12 &&
			observations.inputCalls <= BOOTSTRAP_LIMITS.inputs &&
			observations.confirmations === 8 &&
			observations.pendingCounterDurable === false &&
			observations.rootClaimFeasible === false &&
			observations.auditedInitializationPrefixFeasible === true &&
			hashPattern.test(observations.sourceHash),
		"BOOTSTRAP_WORKER_REPORT_INVALID",
	);
	allowedKeys(observations.cases, [...caseNames, "inputMatrix"]);
	const booleanKeys = [
		"setupAwaited",
		"withSession",
		"errorCaught",
		"auditedSourceFreePrefix",
		"initialPrefixLinear",
		"initialSelectedModelMatches",
		"zeroEntryRootEligible",
		"initialDiskExists",
		"oldContextRejected",
		"oldPiRejected",
		"claimIsRoot",
		"customOnlyDiskExists",
		"syntheticConfirmation",
		"reviewedPayloadFrozen",
		"sourceMatchesReviewedPayload",
		"freshSession",
		"commandBypassesInput",
		"memoryAdvancedOnFailure",
		"failedEntryAbsentFromDisk",
		"replacementActive",
		"sessionFileAbsentAfterFailure",
	];
	for (const name of caseNames) {
		const observed = observations.cases[name];
		allowedKeys(observed, [
			"scenario",
			...booleanKeys,
			"initialEntryTypes",
			"initialFieldNames",
			"initialThinkingLevel",
			"initialLeafId",
			"initialPrefixHash",
			"headerHash",
			"source",
			"claim",
			"receipt",
			"seal",
			"freshContextMode",
			"failedStage",
			"failedSetupInput",
		]);
		for (const key of booleanKeys)
			if (key in observed) requireCondition(typeof observed[key] === "boolean", "BOOTSTRAP_WORKER_REPORT_INVALID");
		if ("freshContextMode" in observed)
			requireCondition(
				["tui", "rpc", "json", "print"].includes(observed.freshContextMode),
				"BOOTSTRAP_WORKER_REPORT_INVALID",
			);
		if ("failedStage" in observed)
			requireCondition(
				["source-first-flush", "receipt", "seal"].includes(observed.failedStage),
				"BOOTSTRAP_WORKER_REPORT_INVALID",
			);
		for (const stage of ["claim", "source", "receipt", "seal"]) if (stage in observed) checkedEntry(observed[stage]);
		if ("failedSetupInput" in observed) checkedInput(observed.failedSetupInput);
		const selected = name === selectedModelCase;
		const expectedTypes = selected ? '["model_change","thinking_level_change"]' : '["thinking_level_change"]';
		const expectedFields = selected
			? '[["id","modelId","parentId","provider","timestamp","type"],["id","parentId","thinkingLevel","timestamp","type"]]'
			: '[["id","parentId","thinkingLevel","timestamp","type"]]';
		requireCondition(
			observed.scenario === name &&
				observed.setupAwaited &&
				observed.oldContextRejected &&
				observed.oldPiRejected &&
				observed.commandBypassesInput &&
				observed.auditedSourceFreePrefix &&
				observed.initialPrefixLinear &&
				typeof observed.initialLeafId === "string" &&
				idPattern.test(observed.initialLeafId) &&
				!observed.zeroEntryRootEligible &&
				!observed.claimIsRoot &&
				!observed.initialDiskExists &&
				!observed.customOnlyDiskExists &&
				observed.initialThinkingLevel === "off" &&
				JSON.stringify(observed.initialEntryTypes) === expectedTypes &&
				JSON.stringify(observed.initialFieldNames) === expectedFields &&
				hashPattern.test(observed.initialPrefixHash) &&
				hashPattern.test(observed.headerHash),
			"BOOTSTRAP_STOCK_PREFIX_INVALID",
		);
		if (selected) requireCondition(observed.initialSelectedModelMatches, "BOOTSTRAP_SELECTED_MODEL_MISMATCH");
		if (name === "custom-only" || name === "source-receipt-seal" || selected) {
			requireCondition(
				!observed.errorCaught && observed.withSession && observed.freshSession && observed.freshContextMode === "tui",
				"BOOTSTRAP_SUCCESS_INCOMPLETE",
			);
		} else {
			const expectedStage =
				name === "first-flush-failure" ? "source-first-flush" : name === "receipt-failure" ? "receipt" : "seal";
			requireCondition(
				observed.errorCaught &&
					!observed.withSession &&
					observed.memoryAdvancedOnFailure &&
					observed.failedEntryAbsentFromDisk &&
					observed.replacementActive &&
					observed.failedStage === expectedStage &&
					observed.failedSetupInput?.reason === "unresolved" &&
					observed.failedSetupInput.mode === "print" &&
					!observed.failedSetupInput.hasUI,
				"BOOTSTRAP_FAILURE_INCOMPLETE",
			);
		}
		if (name !== "custom-only")
			requireCondition(observed.syntheticConfirmation && observed.reviewedPayloadFrozen, "BOOTSTRAP_REVIEW_INCOMPLETE");
	}
	for (const name of ["source-receipt-seal", selectedModelCase]) {
		const success = observations.cases[name];
		const sourceCount = name === selectedModelCase ? 5 : 4;
		requireCondition(
			success.sourceMatchesReviewedPayload &&
				success.claim.parentId === success.initialLeafId &&
				success.source.parentId === success.claim.id &&
				success.receipt.parentId === success.source.id &&
				success.seal.parentId === success.receipt.id &&
				success.source.recordCount === sourceCount &&
				success.receipt.recordCount === sourceCount + 1 &&
				success.seal.recordCount === sourceCount + 2 &&
				success.source.diskHash !== success.receipt.diskHash &&
				success.receipt.diskHash !== success.seal.diskHash &&
				observations.cases["first-flush-failure"].sessionFileAbsentAfterFailure,
			"BOOTSTRAP_READBACK_INCOMPLETE",
		);
	}
	const matrix = observations.cases.inputMatrix;
	requireCondition(Array.isArray(matrix) && matrix.length === 9, "BOOTSTRAP_INPUT_MATRIX_INVALID");
	for (const input of matrix) checkedInput(input);
	requireCondition(
		matrix[0].reason === "unresolved" &&
			matrix[1].reason === "cancelled" &&
			matrix[2].reason === "reviewed-unenrolled" &&
			[3, 4, 5, 6, 7].every((index) => matrix[index].reason === "unsupported-origin") &&
			[3, 4, 5].every((index) => matrix[index].hasUI) &&
			matrix[8].reason === "review-failed",
		"BOOTSTRAP_INPUT_MATRIX_INVALID",
	);
	return observations;
}

export function runBootstrapPrototype({ stockRoot }) {
	const cohort = inspectOfficialPi(stockRoot, "1.1.0");
	const directory = mkdtempSync(join(tmpdir(), "pi-authority-bootstrap-"));
	try {
		const result = spawnSync(
			process.execPath,
			[
				"--import",
				fileURLToPath(new URL("../eval/deny-network.mjs", import.meta.url)),
				scriptFile,
				"--worker",
				resolve(stockRoot),
				directory,
			],
			{
				cwd: directory,
				env: isolatedEnvironment(join(directory, "agent")),
				encoding: "utf8",
				timeout: BOOTSTRAP_LIMITS.workerMs,
				maxBuffer: BOOTSTRAP_LIMITS.reportBytes,
			},
		);
		requireCondition(!result.error && result.status === 0, "BOOTSTRAP_WORKER_FAILED");
		const observations = validateBootstrapObservations(JSON.parse(result.stdout));
		return {
			version: 2,
			claim: "synthetic public-API lifecycle only; no authentic-human, authority, rollback, or crash-durability claim",
			host: cohort,
			harnessSha256: sha256(readFileSync(scriptFile)),
			limits: BOOTSTRAP_LIMITS,
			...observations,
		};
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

// Public, isolated SDK wiring for other offline protocol experiments. The
// caller supplies its own synthetic extension; no authority bridge dependency.
export async function createBootstrapSdkHarness({ sdk, directory, factory, mode = "tui", ui, model }) {
	const cwd = join(directory, "cwd");
	const agentDir = join(directory, "agent");
	const sessionDir = join(directory, "sessions");
	for (const folder of [cwd, agentDir, sessionDir]) mkdirSync(folder, { recursive: true });
	const modelRuntime = await sdk.ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: null,
		allowModelNetwork: false,
	});
	let replacements = 0;
	let providerStarts = 0;
	const createRuntime = async (options) => {
		requireCondition(++replacements <= BOOTSTRAP_LIMITS.replacements, "BOOTSTRAP_REPLACEMENT_LIMIT");
		const services = await sdk.createAgentSessionServices({
			cwd,
			agentDir,
			modelRuntime,
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				extensionFactories: [{ name: "authority-bootstrap-prototype", factory }],
			},
		});
		requireCondition(services.diagnostics.length === 0, "BOOTSTRAP_SERVICE_DIAGNOSTIC");
		const created = await sdk.createAgentSessionFromServices({
			services,
			sessionManager: options.sessionManager,
			sessionStartEvent: options.sessionStartEvent,
			model,
			thinkingLevel: "off",
			noTools: "all",
		});
		requireCondition(
			created.extensionsResult.extensions.length === 1 && created.extensionsResult.errors.length === 0,
			"BOOTSTRAP_EXTENSION_SET",
		);
		created.session.subscribe((event) => {
			if (event.type === "agent_start") providerStarts++;
		});
		return { ...created, services, diagnostics: services.diagnostics };
	};
	const host = await sdk.createAgentSessionRuntime(createRuntime, {
		cwd,
		agentDir,
		sessionManager: sdk.SessionManager.create(cwd, sessionDir),
	});
	const bind = (session) =>
		session.bindExtensions({
			mode,
			uiContext: ui,
			commandContextActions: { newSession: (options) => host.newSession(options) },
			onError: () => {},
		});
	host.setRebindSession(bind);
	await bind(host.session);
	return {
		host,
		bind,
		get providerStarts() {
			return providerStarts;
		},
		get replacements() {
			return replacements;
		},
		close() {
			host.session.dispose();
		},
	};
}

async function runWorker(stockRoot, directory) {
	checkOutsideRepository(directory);
	inspectOfficialPi(stockRoot, "1.1.0");
	const sdk = await import(
		pathToFileURL(join(stockRoot, "node_modules/@earendil-works/pi-coding-agent/dist/index.js")).href
	);
	requireCondition(sdk.VERSION === "1.1.0", "BOOTSTRAP_SDK_VERSION");
	const source = freezeBootstrapInput(`${String.fromCodePoint(0x6d4b, 0x8bd5)}${randomBytes(24).toString("hex")}`);
	const reviewedMessage = Object.freeze({
		role: "user",
		content: Object.freeze([Object.freeze({ type: "text", text: source.text })]),
		timestamp: 1,
	});
	const receipt = Object.freeze({ version: 0, synthetic: true, sourceHash: source.hash });
	const observations = {
		protocol: "synthetic-stock-public-api",
		providerStarts: 0,
		commandCalls: 0,
		inputCalls: 0,
		confirmations: 0,
		pendingCounterDurable: false,
		cases: {},
	};
	let scenario;
	let harness;
	let commandResult;
	let lastInput;
	let confirmation = true;
	let confirmationFails = false;
	const scriptedUi = {
		confirm: async () => {
			observations.confirmations++;
			if (confirmationFails) throw controlled("BOOTSTRAP_SYNTHETIC_UI_FAILURE");
			return confirmation;
		},
		notify: () => {},
	};
	const factory = (pi) => {
		pi.registerCommand(command, {
			description: "Offline synthetic lifecycle experiment",
			handler: async (_args, oldContext) => {
				observations.commandCalls++;
				const previousSessionId = oldContext.sessionManager.getSessionId();
				const result = { scenario, setupAwaited: false, withSession: false, errorCaught: false };
				commandResult = result;
				try {
					if (scenario !== "custom-only") {
						result.syntheticConfirmation = await boundedBootstrapOperation(() =>
							oldContext.ui.confirm("Synthetic source review", source.text),
						);
						requireCondition(result.syntheticConfirmation, "BOOTSTRAP_SYNTHETIC_REVIEW_DECLINED");
						result.reviewedPayloadFrozen =
							Object.isFrozen(reviewedMessage) &&
							Object.isFrozen(reviewedMessage.content) &&
							Object.isFrozen(reviewedMessage.content[0]) &&
							Object.isFrozen(source);
					}
					await oldContext.newSession({
						setup: async (manager) => {
							await Promise.resolve();
							result.setupAwaited = true;
							const prefix = manager.getEntries();
							result.initialEntryTypes = prefix.map((entry) => entry.type);
							result.initialFieldNames = prefix.map((entry) => Object.keys(entry).sort());
							result.initialThinkingLevel = prefix.at(-1)?.thinkingLevel;
							result.initialLeafId = prefix.at(-1)?.id;
							result.initialPrefixLinear =
								prefix[0]?.parentId === null &&
								prefix.every((entry, index) => index === 0 || entry.parentId === prefix[index - 1].id);
							result.initialPrefixHash = sha256(JSON.stringify(prefix));
							result.headerHash = sha256(JSON.stringify(manager.getHeader()));
							const selected = scenario === selectedModelCase;
							if (selected)
								result.initialSelectedModelMatches =
									prefix[0]?.provider === syntheticModel.provider && prefix[0]?.modelId === syntheticModel.id;
							result.auditedSourceFreePrefix =
								result.initialPrefixLinear &&
								prefix.at(-1)?.type === "thinking_level_change" &&
								prefix.at(-1)?.thinkingLevel === "off" &&
								(selected
									? prefix.length === 2 && prefix[0].type === "model_change" && result.initialSelectedModelMatches
									: prefix.length === 1);
							requireCondition(result.auditedSourceFreePrefix, "BOOTSTRAP_UNREVIEWED_STOCK_PREFIX");
							result.zeroEntryRootEligible = manager.getEntries().length === 0 && !manager.getHeader().parentSession;
							result.initialDiskExists = existsSync(manager.getSessionFile());
							result.oldContextRejected = false;
							result.oldPiRejected = false;
							try {
								oldContext.sessionManager.getSessionId();
							} catch {
								result.oldContextRejected = true;
							}
							try {
								pi.appendEntry("authority-bootstrap-stale", {});
							} catch {
								result.oldPiRejected = true;
							}
							// Only the explicitly audited, source-free stock prefix may
							// precede this fixture. There is no persistent sidecar here.
							const claimId = manager.appendCustomEntry("authority-bootstrap-fixture-claim", {
								...receipt,
								prefixHash: result.initialPrefixHash,
								headerHash: result.headerHash,
							});
							result.claimIsRoot = manager.getEntry(claimId).parentId === null;
							result.customOnlyDiskExists = existsSync(manager.getSessionFile());
							if (scenario === "custom-only") return;
							if (scenario === "first-flush-failure") {
								const file = manager.getSessionFile();
								mkdirSync(file);
								try {
									manager.appendMessage(reviewedMessage);
								} catch {
									result.memoryAdvancedOnFailure =
										manager.getLeafEntry().type === "message" && manager.getLeafEntry().message.role === "user";
									result.failedEntryAbsentFromDisk = !lstatSync(file).isFile();
									result.failedStage = "source-first-flush";
								} finally {
									rmSync(file, { recursive: true });
								}
								result.sessionFileAbsentAfterFailure = !existsSync(file);
								throw controlled("BOOTSTRAP_SYNTHETIC_SETUP_FAILURE");
							}
							const sourceId = manager.appendMessage(reviewedMessage);
							result.source = bootstrapEntryReadback(manager, sourceId);
							result.sourceMatchesReviewedPayload =
								JSON.stringify(manager.getEntry(sourceId).message) === JSON.stringify(reviewedMessage);
							requireCondition(result.sourceMatchesReviewedPayload, "BOOTSTRAP_REVIEWED_SOURCE_CHANGED");
							result.claim = bootstrapEntryReadback(manager, claimId);
							requireCondition(result.source.parentId === claimId, "BOOTSTRAP_SOURCE_ORDER");
							const failAt =
								scenario === "receipt-failure" ? "receipt" : scenario === "seal-failure" ? "seal" : undefined;
							for (const stage of ["receipt", "seal"]) {
								if (failAt === stage) {
									const file = manager.getSessionFile();
									const before = readBootstrapSession(file);
									rmSync(file);
									mkdirSync(file);
									try {
										manager.appendCustomEntry(`authority-bootstrap-fixture-${stage}`, receipt);
									} catch {
										const advanced = manager.getLeafEntry();
										result.memoryAdvancedOnFailure = advanced.customType === `authority-bootstrap-fixture-${stage}`;
										result.failedEntryAbsentFromDisk = !before.records.some((entry) => entry.id === advanced.id);
										result.failedStage = stage;
									} finally {
										rmSync(file, { recursive: true });
										writeFileSync(file, before.bytes, { flag: "wx", mode: 0o600 });
									}
									result.failedEntryAbsentFromDisk = !readBootstrapSession(file).records.some(
										(entry) => entry.id === manager.getLeafEntry().id,
									);
									requireCondition(
										result.memoryAdvancedOnFailure && result.failedEntryAbsentFromDisk,
										"BOOTSTRAP_FAILURE_NOT_OBSERVED",
									);
									throw controlled("BOOTSTRAP_SYNTHETIC_SETUP_FAILURE");
								}
								const id = manager.appendCustomEntry(`authority-bootstrap-fixture-${stage}`, receipt);
								result[stage] = bootstrapEntryReadback(manager, id);
							}
						},
						withSession: async (context) => {
							result.withSession = true;
							result.freshSession = context.sessionManager.getSessionId() !== previousSessionId;
							result.freshContextMode = context.mode;
						},
					});
				} catch {
					result.errorCaught = true;
					result.replacementActive = harness.host.session.sessionId !== previousSessionId;
				}
			},
		});
		pi.on("input", async (event, context) => {
			requireCondition(++observations.inputCalls <= BOOTSTRAP_LIMITS.inputs, "BOOTSTRAP_INPUT_LIMIT");
			lastInput = {
				source: event.source,
				mode: context.mode,
				hasUI: context.hasUI,
				action: "handled",
				reason: "unresolved",
				diskChanged: false,
			};
			try {
				if (!event.text.startsWith(protocol)) return { action: "handled" };
				if (event.source !== "interactive" || context.mode !== "tui" || !context.hasUI) {
					lastInput.reason = "unsupported-origin";
					return { action: "handled" };
				}
				const frozen = freezeBootstrapInput(event.text.slice(protocol.length));
				const approved = await boundedBootstrapOperation(() => context.ui.confirm("Synthetic review", frozen.text));
				if (!approved) {
					lastInput.reason = "cancelled";
					return { action: "handled" };
				}
				// Scripted approval does not enroll authority. This fixture has no
				// pending sidecar, bridge guards, or instruction projection.
				lastInput.reason = "reviewed-unenrolled";
				return { action: "handled" };
			} catch {
				lastInput.reason = "review-failed";
				return { action: "handled" };
			}
		});
	};
	harness = await createBootstrapSdkHarness({ sdk, directory, factory, ui: scriptedUi });
	try {
		const prompt = async (text, sourceLabel) => {
			let disposition;
			await boundedBootstrapOperation(() =>
				harness.host.session.prompt(text, {
					source: sourceLabel,
					preflightResult: (result) => {
						disposition = result;
					},
				}),
			);
			requireCondition(disposition === "handled", "BOOTSTRAP_INPUT_NOT_HANDLED");
			return disposition;
		};
		for (const name of [
			"custom-only",
			"source-receipt-seal",
			"first-flush-failure",
			"receipt-failure",
			"seal-failure",
		]) {
			scenario = name;
			const inputsBefore = observations.inputCalls;
			commandResult = undefined;
			await prompt(`/${command}`, "extension");
			requireCondition(
				commandResult?.scenario === name && commandResult.setupAwaited,
				"BOOTSTRAP_COMMAND_SETUP_MISSING",
			);
			commandResult.commandBypassesInput = inputsBefore === observations.inputCalls;
			observations.cases[name] = commandResult;
			if (commandResult.errorCaught) {
				await prompt(source.text, "interactive");
				commandResult.failedSetupInput = lastInput;
				await harness.bind(harness.host.session);
			}
		}
		observations.cases.inputMatrix = [];
		for (const [mode, inputSource, approve, text, failReview = false] of [
			["tui", "interactive", true, source.text],
			["tui", "interactive", false, protocol + source.text],
			["tui", "interactive", true, protocol + source.text],
			["rpc", "interactive", true, protocol + source.text],
			["print", "interactive", true, protocol + source.text],
			["json", "interactive", true, protocol + source.text],
			["tui", "rpc", true, protocol + source.text],
			["tui", "extension", true, protocol + source.text],
			["tui", "interactive", true, protocol + source.text, true],
		]) {
			confirmation = approve;
			confirmationFails = failReview;
			await harness.host.session.bindExtensions({ mode, uiContext: scriptedUi });
			const before = harness.host.session.sessionManager.getEntries().length;
			lastInput = undefined;
			await prompt(text, inputSource);
			requireCondition(before === harness.host.session.sessionManager.getEntries().length, "BOOTSTRAP_INPUT_PERSISTED");
			observations.cases.inputMatrix.push(lastInput);
		}
		observations.providerStarts = harness.providerStarts;
		observations.replacements = harness.replacements;
		harness.close();
		confirmation = true;
		confirmationFails = false;
		harness = await createBootstrapSdkHarness({
			sdk,
			directory: join(directory, "selected-model"),
			factory,
			ui: scriptedUi,
			model: syntheticModel,
		});
		scenario = selectedModelCase;
		commandResult = undefined;
		const inputsBefore = observations.inputCalls;
		await prompt(`/${command}`, "extension");
		requireCondition(
			commandResult?.scenario === selectedModelCase && commandResult.setupAwaited,
			"BOOTSTRAP_COMMAND_SETUP_MISSING",
		);
		commandResult.commandBypassesInput = inputsBefore === observations.inputCalls;
		observations.cases[selectedModelCase] = commandResult;
		observations.providerStarts += harness.providerStarts;
		observations.replacements += harness.replacements;
		observations.rootClaimFeasible = observations.cases["source-receipt-seal"].zeroEntryRootEligible;
		observations.auditedInitializationPrefixFeasible =
			observations.cases["source-receipt-seal"].auditedSourceFreePrefix;
		observations.sourceHash = source.hash;
		return observations;
	} finally {
		harness.close();
	}
}

if (process.argv[1] && resolve(process.argv[1]) === scriptFile) {
	try {
		if (process.argv[2] === "--worker") {
			requireCondition(
				process.argv.length === 5 && process.env.PI_OFFLINE === "1" && process.env.EVAL_MODEL_CALL_BUDGET === "0",
				"BOOTSTRAP_WORKER_USAGE",
			);
			console.log(JSON.stringify(await runWorker(resolve(process.argv[3]), resolve(process.argv[4]))));
		} else {
			const options = parseBootstrapArguments(process.argv.slice(2));
			const report = JSON.stringify(runBootstrapPrototype(options), null, 2);
			requireCondition(Buffer.byteLength(report) <= BOOTSTRAP_LIMITS.reportBytes, "BOOTSTRAP_REPORT_LIMIT");
			if (options.reportFile) writeFileSync(options.reportFile, `${report}\n`, { flag: "wx", mode: 0o600 });
			console.log(report);
		}
	} catch (error) {
		const code =
			error instanceof Error && /^BOOTSTRAP_[A-Z_]+$/.test(error.message)
				? error.message
				: "BOOTSTRAP_PROTOTYPE_FAILED";
		console.error(code);
		process.exitCode = code === "BOOTSTRAP_USAGE" ? 2 : 1;
	}
}

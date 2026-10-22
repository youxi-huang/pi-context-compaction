import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { constants, tmpdir, userInfo } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { PRIMARY_PI_VERSION, SUPPORTED_PI_VERSIONS } from "../packages/coding-agent/src/extensions/context-memory/preview/compatibility.ts";
import { CORE_PACKAGE, coreIdentitySynchronized, coreImportViolations } from "./context-memory-core-check.mjs";
import { officialPiReady as officialPiCohortReady } from "./context-memory-preview-stock-install.mjs";
import { assertProfileVersion, VERSION as FUNCTIONAL_PREVIEW_VERSION } from "./context-memory-preview-acceptance-profile.mjs";
import { releasePlan } from "./context-memory-preview-release-checks.mjs";

// Command order comes from .github/workflows/context-memory.yml; do not add a second pipeline.
const usage =
	"Usage: node scripts/context-memory-ops.mjs <doctor|deps|build|verify|preview|eval|ci> [--verbose] [eval: --full --keep] [preview/ci: --acceptance-profile <profile>]";
const args = process.argv.slice(2);
const profileIndex = args.indexOf("--acceptance-profile");
const profile = profileIndex < 0 ? "strict" : args[profileIndex + 1];
const operationArgs = args.filter((_, index) => profileIndex < 0 || (index !== profileIndex && index !== profileIndex + 1));
const commands = new Set(["doctor", "deps", "build", "verify", "preview", "eval", "ci"]);
const positional = operationArgs.filter((arg) => !arg.startsWith("--"));
const command = positional[0];
const flags = new Set(operationArgs.filter((arg) => arg.startsWith("--")));
if (args.length === 1 && args[0] === "--help") {
	console.log(usage);
	process.exit(0);
}
if (
	positional.length !== 1 ||
	!commands.has(command) ||
	(profileIndex >= 0 && (!profile || profile.startsWith("--") || !["preview", "ci"].includes(command) || args.filter((arg) => arg === "--acceptance-profile").length !== 1)) ||
	[...flags].some((flag) => flag !== "--verbose" && !(command === "eval" && ["--full", "--keep"].includes(flag)))
) {
	console.error(usage);
	process.exit(2);
}
try {
	assertProfileVersion(profile, FUNCTIONAL_PREVIEW_VERSION);
} catch (error) {
	console.error(error.message);
	process.exit(2);
}

class StepError extends Error {
	constructor(message, code = 1) {
		super(message);
		this.code = code;
	}
}

const verbose = flags.has("--verbose");
const scriptRoot = fileURLToPath(new URL("../", import.meta.url));
const rootResult = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: scriptRoot, encoding: "utf8" });
if (rootResult.error || rootResult.status !== 0) {
	console.error(rootResult.error?.message ?? rootResult.stderr);
	process.exit(rootResult.status ?? 1);
}
const root = realpathSync(rootResult.stdout.trim());
const extension = "packages/coding-agent/src/extensions/context-memory";
const fingerprintFile = `${extension}/build.ts`;
const stockRoot = join(root, ".artifacts/context-memory-preview-stock");
const otherStockRoot = join(root, ".artifacts/context-memory-preview-stock-1.0.4");
/** The primary host uses the documented root; each older supported host has its own. */
function hostRoot(host, primary = PRIMARY_PI_VERSION) {
	return host === primary ? stockRoot : join(root, `.artifacts/context-memory-preview-stock-${host}`);
}
const lockMarker = join(root, "node_modules/.context-memory-ops-lock");
const identity = userInfo();
const uid = process.getuid?.() ?? identity.username.replace(/[^\w-]/g, "_");
const logParent = join(tmpdir(), `context-memory-ops-${uid}`);
mkdirSync(logParent, { recursive: true, mode: 0o700 });
const logDirectory = mkdtempSync(join(logParent, "run-"));
const env = { ...process.env, PI_OFFLINE: "1", EVAL_PROVIDER_MODE: "scripted", EVAL_MODEL_CALL_BUDGET: "0" };
let stepNumber = 0;
let fingerprintChanged = false;

function git(args) {
	const result = spawnSync("git", args, { cwd: root, env, encoding: "utf8" });
	if (result.error) throw new StepError(result.error.message, result.error.code === "ENOENT" ? 127 : 1);
	if (result.status !== 0)
		throw new StepError(result.stderr.trim() || `git ${args.join(" ")} failed`, result.status ?? 1);
	return result.stdout;
}

async function step(name, operation) {
	console.log(`== ${name}`);
	const started = performance.now();
	const logFile = join(logDirectory, `${String(++stepNumber).padStart(2, "0")}-${name}.log`);
	const descriptor = openSync(logFile, "w", 0o600);
	const write = (data) => {
		writeSync(descriptor, data);
		if (verbose) process.stdout.write(data);
	};
	let failure;
	try {
		await operation(write);
	} catch (error) {
		failure = error;
		write(`${error.message}\n`);
	} finally {
		closeSync(descriptor);
	}
	const seconds = ((performance.now() - started) / 1000).toFixed(2);
	if (failure) {
		const code = failure instanceof StepError ? failure.code : 1;
		console.error(`   failed (exit ${code}, ${seconds}s)`);
		console.error(readFileSync(logFile, "utf8").trimEnd().split(/\r?\n/).slice(-40).join("\n"));
		throw new StepError("", code);
	}
	console.log(`   ok (${seconds}s)`);
}

function execute(program, args, write, extraEnv = {}) {
	write(`$ ${program === process.execPath ? "node" : program} ${args.join(" ")}\n`);
	return new Promise((resolve, reject) => {
		const child = spawn(program, args, {
			cwd: root,
			env: { ...env, ...extraEnv },
			stdio: ["ignore", "pipe", "pipe"],
		});
		child.stdout.on("data", write);
		child.stderr.on("data", write);
		child.on("error", (error) => reject(new StepError(error.message, error.code === "ENOENT" ? 127 : 1)));
		child.on("close", (code, signal) => {
			if (code === 0) resolve();
			else
				reject(
					new StepError(
						`${program === process.execPath ? "node" : program} exited ${signal ?? code}`,
						code ?? 128 + (constants.signals[signal] ?? 0),
					),
				);
		});
	});
}

function nodeStep(name, args, extraEnv) {
	return step(name, (write) => execute(process.execPath, args, write, extraEnv));
}

function filesIn(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		return entry.isDirectory() ? filesIn(path) : [path];
	});
}

function duplicateFiles() {
	return [extension, "scripts"]
		.flatMap((directory) => filesIn(join(root, directory)))
		.filter((file) => /(?: \d+| \(\d+\)|[ -](?:copy|副本)(?: \d+)?)(?=\.[^.]+$)/i.test(file.split(sep).at(-1)))
		.map((file) => relative(root, file))
		.sort();
}

function assertNoDuplicates(write) {
	const files = duplicateFiles();
	if (files.length) throw new StepError(`Duplicate filenames; remove or review before stamping:\n${files.join("\n")}`);
	write("No duplicate filenames in the extension or scripts directories.\n");
}

function lockHash() {
	return createHash("sha256")
		.update(readFileSync(join(root, "package-lock.json")))
		.digest("hex");
}

function dependencyState(hash) {
	const installed = [
		"node_modules/.package-lock.json",
		"node_modules/typescript/bin/tsc",
		"node_modules/vitest/dist/cli.js",
		"node_modules/@biomejs/biome/bin/biome",
		"node_modules/esbuild/package.json",
	].every((file) => existsSync(join(root, file)));
	const marked = existsSync(lockMarker) && readFileSync(lockMarker, "utf8").trim() === hash;
	return { installed, marked };
}

function officialPiReady(directory = stockRoot, version = PRIMARY_PI_VERSION) {
	return officialPiCohortReady(directory, version);
}

async function doctor() {
	await step("doctor", async (write) => {
		write(`user: ${identity.username}; uid: ${uid}\nHOME: ${process.env.HOME ?? "unset"}\n`);
		write(
			`Node: ${process.version}; CI uses 22${process.versions.node.startsWith("22.") ? "" : " (different major)"}\n`,
		);
		write(
			`branch: ${git(["branch", "--show-current"]).trim() || "detached"}\ncommit: ${git(["rev-parse", "HEAD"]).trim()}\n`,
		);
		write(`shallow clone: ${git(["rev-parse", "--is-shallow-repository"]).trim()}\n`);
		const pin = readFileSync(join(root, "eval/runtime.ts"), "utf8").match(
			/EVALUATED_RUNTIME_PIN\s*=\s*["']([0-9a-f]{40})["']/,
		)?.[1];
		if (!pin) throw new StepError("Cannot read EVALUATED_RUNTIME_PIN from eval/runtime.ts");
		const pinned = spawnSync("git", ["cat-file", "-e", `${pin}^{commit}`], { cwd: root, env, encoding: "utf8" });
		if (pinned.error) throw pinned.error;
		write(`evaluation pin: ${pin}; ${pinned.status === 0 ? "present" : "missing (CI requires full history)"}\n`);
		const { installed, marked } = dependencyState(lockHash());
		write(
			`dependencies: ${installed ? "installed" : "missing/incomplete"}; lock marker: ${marked ? "current" : "missing/stale (deps will install)"}\n`,
		);
		for (const host of SUPPORTED_PI_VERSIONS) {
			const role = host === PRIMARY_PI_VERSION ? "official" : "supported";
			write(`${role} Pi ${host}: ${officialPiReady(hostRoot(host), host) ? "ready" : "not ready (preview will install)"}\n`);
		}
		write(
			`official Pi 1.0.4 scenario control: ${officialPiReady(otherStockRoot, "1.0.4") ? "ready" : "not ready (preview will install)"}\n`,
		);
		write(
			`pinned model-data archive: ${existsSync(join(root, ".artifacts/pi-1.1.0-source.tar.gz")) ? "cached" : "missing (build downloads the pinned archive and verifies SHA-256)"}\n`,
		);
		const corePresent = existsSync(join(root, CORE_PACKAGE, "package.json"));
		write(`host-neutral core: ${corePresent ? `present (${CORE_PACKAGE})` : `missing (${CORE_PACKAGE})`}\n`);
		if (corePresent) {
			const { installed } = dependencyState(lockHash());
			const violations = installed ? await coreImportViolations(join(root, CORE_PACKAGE)) : null;
			write(
				`core import gate: ${violations === null ? "not checkable before deps install" : violations.length ? `${violations.length} violation(s) (verify will fail)` : "clean (relative-in-package, node:*, typebox)"}\n`,
			);
			write(`core identity.ts: ${coreIdentitySynchronized(root) ? "byte-identical to the resident copy" : "DRIFTED from the resident copy (verify will fail)"}\n`);
		}
		const untracked = git(["ls-files", "--others", "-z", "--", extension])
			.split("\0")
			.filter((file) => file.endsWith(".ts"));
		write(`untracked extension .ts files: ${untracked.length ? `\n${untracked.join("\n")}` : "none"}\n`);
		const status = git(["status", "--porcelain"]);
		write(`worktree: ${status ? `dirty\n${status}` : "clean\n"}`);
		assertNoDuplicates(write);
	});
}

async function deps() {
	await step("deps", async (write) => {
		const hash = lockHash();
		const { installed, marked } = dependencyState(hash);
		if (installed && marked) {
			write("Dependencies match package-lock.json; no installation needed.\n");
			return;
		}
		await execute("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline"], write);
		writeFileSync(lockMarker, `${hash}\n`);
	});
}

async function build() {
	await deps();
	await step("duplicate-files", assertNoDuplicates);
	await nodeStep("model-data", ["scripts/context-memory-model-data.mjs"]);
	await nodeStep("stamp", ["scripts/stamp-context-memory.mjs"]);
	await step("fingerprint", (write) => {
		const diff = spawnSync("git", ["diff", "--quiet", "--", fingerprintFile], { cwd: root, env, encoding: "utf8" });
		if (diff.error) throw diff.error;
		if (diff.status === 1) {
			fingerprintChanged = true;
			const warning =
				"!!! FINGERPRINT GATE: A fingerprinted runtime or host file changed.\n!!! Obtain the maintainer's explicit approval in this task before committing a new build.ts fingerprint. Checks will continue; the final exit code will be 3. No commit or restore is performed.";
			write(`${warning}\n`);
			if (!verbose) console.error(warning);
		} else if (diff.status !== 0) {
			throw new StepError(diff.stderr.trim(), diff.status ?? 1);
		} else {
			write("Published runtime fingerprint is unchanged.\n");
		}
	});
	await step("build-offline", (write) => execute("npm", ["run", "build:offline"], write));
}

async function checks() {
	await nodeStep("context-memory-check", ["scripts/context-memory-check.mjs"]);
	await nodeStep("security-regression-check", ["scripts/security-regression-check.mjs"]);
}

async function installOfficialPi(name, directory, version) {
	await step(name, async (write) => {
		await execute(
			process.execPath,
			[
				"scripts/context-memory-preview-stock-install.mjs",
				"--stock-root",
				directory,
				"--version",
				version,
			],
			write,
		);
		if (!officialPiReady(directory, version))
			throw new StepError(`Official Pi ${version} installation is incomplete`);
	});
}

async function preview() {
	await nodeStep("preview-build", ["scripts/context-memory-preview-build.mjs"]);
	const packageDir = join(root, ".artifacts/context-memory-preview-package");
	const read = (file) => JSON.parse(readFileSync(join(packageDir, file), "utf8"));
	// The same plan CI and publication read from the candidate's own metadata.
	const plan = releasePlan({ manifest: read("package.json"), build: read("preview-build.json") });
	assertProfileVersion(profile, plan.version);
	const [primary, ...older] = plan.hosts;
	for (const host of plan.hosts) {
		await installOfficialPi(host === primary ? "official-pi" : `official-pi-${host}`, hostRoot(host, primary), host);
	}
	await nodeStep("preview-acceptance", [
		"scripts/context-memory-preview-acceptance.mjs",
		"--package-dir",
		".artifacts/context-memory-preview-package",
		"--stock-root",
		hostRoot(primary, primary),
		...older.flatMap((host) => ["--compatible-stock-root", hostRoot(host, primary)]),
		"--output-dir",
		".artifacts/context-memory-preview-acceptance",
	]);
	for (const host of older) {
		await nodeStep(`preview-acceptance-${host}`, [
			"scripts/context-memory-preview-acceptance.mjs", "--package-dir", ".artifacts/context-memory-preview-package",
			"--stock-root", hostRoot(host, primary), "--output-dir", `.artifacts/context-memory-preview-acceptance-${host}`,
		]);
	}
	await installOfficialPi(`official-pi-${plan.otherHost}`, otherStockRoot, plan.otherHost);
	await nodeStep("preview-scenarios", [
		"scripts/context-memory-preview-scenarios.mjs",
		"--package-dir",
		".artifacts/context-memory-preview-package",
		"--stock-root",
		hostRoot(primary, primary),
		"--other-stock-root",
		".artifacts/context-memory-preview-stock-1.0.4",
		"--output-dir",
		".artifacts/context-memory-preview-scenarios",
		"--acceptance-profile",
		profile,
	]);
	await nodeStep("preview-release-checks", ["--test", "scripts/context-memory-preview-release-checks.test.mjs"]);
	await nodeStep("preview-release-prepare", ["scripts/context-memory-preview-release.mjs", "--prepare"]);
}

async function evaluate(full) {
	const artifacts = mkdtempSync(join(logDirectory, "eval-"));
	try {
		if (full) {
			await nodeStep("eval-full", ["eval/check.mjs"], { EVAL_ARTIFACT_DIR: artifacts });
		} else {
			await nodeStep(
				"eval-reduced",
				[
					"node_modules/vitest/dist/cli.js",
					"run",
					"--config",
					"packages/coding-agent/vitest.config.ts",
					"eval/live/minimal.test.ts",
				],
				{ EVAL_ARTIFACT_DIR: artifacts, NODE_OPTIONS: "--import=./eval/deny-network.mjs" },
			);
		}
	} finally {
		if (flags.has("--keep")) console.log(`Evaluation artifacts: ${artifacts}`);
		else rmSync(artifacts, { recursive: true, force: true });
	}
}

try {
	if (command === "doctor") await doctor();
	else if (command === "deps") await deps();
	else {
		await build();
		if (command === "verify" || command === "ci") await checks();
		if (command === "preview" || command === "ci") await preview();
		if (command === "eval" || command === "ci") await evaluate(command === "ci" || flags.has("--full"));
	}
	process.exitCode = fingerprintChanged ? 3 : 0;
} catch (error) {
	if (error.message) console.error(error.message);
	process.exitCode = error instanceof StepError ? error.code : 1;
} finally {
	console.log(`Logs: ${logDirectory}`);
}

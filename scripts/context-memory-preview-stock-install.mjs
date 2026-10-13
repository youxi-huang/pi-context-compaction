import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Reviewed runtime cohort from the official 1.1.0 and 1.0.4 manifests. The coding
// agent names the first six dependencies; pi-ai also names pi-telemetry. Dev-only
// client/protocol/server packages are deliberately not installed.
export const OFFICIAL_PI_COHORT = Object.freeze([
	"@earendil-works/pi-coding-agent",
	"@earendil-works/chord",
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-codemode",
	"@earendil-works/pi-mcp",
	"@earendil-works/pi-tui",
	"@earendil-works/pi-telemetry",
]);
export const OFFICIAL_PI_VERSIONS = Object.freeze(["1.1.0", "1.0.4"]);
const cohort = new Set(OFFICIAL_PI_COHORT);
const usage = "Usage: node scripts/context-memory-preview-stock-install.mjs --stock-root <directory> --version <1.1.0|1.0.4> [--check]";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function checkedVersion(version) {
	if (!OFFICIAL_PI_VERSIONS.includes(version)) throw new Error(`Unsupported official Pi version: ${version}`);
	return version;
}

export function parseStockInstallArguments(args) {
	const options = { check: false };
	for (let index = 0; index < args.length; index++) {
		const flag = args[index];
		if (flag === "--check" && !options.check) options.check = true;
		else if ((flag === "--stock-root" || flag === "--version") && args[index + 1] && !args[index + 1].startsWith("--")) {
			const key = flag === "--stock-root" ? "stockRoot" : "version";
			if (options[key] !== undefined) throw new Error(usage);
			options[key] = args[++index];
		} else throw new Error(usage);
	}
	if (!options.stockRoot || !options.version) throw new Error(usage);
	checkedVersion(options.version);
	options.stockRoot = resolve(options.stockRoot);
	return options;
}

function readJson(file) {
	return JSON.parse(readFileSync(file, "utf8"));
}

function assertIntegrity(record, name, version) {
	const expectedUrl = `https://registry.npmjs.org/${name}/-/${name.split("/")[1]}-${version}.tgz`;
	if (record?.version !== version || record.link || record.resolved !== expectedUrl || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(record.integrity ?? "")) {
		throw new Error(`Missing or unexpected official package provenance: ${name}`);
	}
}

export function inspectOfficialPi(stockRoot, version) {
	checkedVersion(version);
	const directory = realpathSync(resolve(stockRoot));
	assertIsolatedInstallTarget(directory);
	const installation = readJson(join(directory, "package.json"));
	if (OFFICIAL_PI_COHORT.some((name) => installation.dependencies?.[name] !== version)) {
		throw new Error("Official installation must pin every runtime cohort dependency exactly");
	}
	const lockBytes = readFileSync(join(directory, "node_modules/.package-lock.json"));
	const lock = JSON.parse(lockBytes.toString("utf8"));
	if (!lock.packages || lock.lockfileVersion < 2) throw new Error("Missing official installation lock metadata");
	const packages = [];
	for (const name of OFFICIAL_PI_COHORT) {
		const packageKey = `node_modules/${name}`;
		const packageRoot = join(directory, packageKey);
		if (!realpathSync(packageRoot).startsWith(`${directory}${sep}`)) throw new Error(`Official package escapes isolated root: ${name}`);
		const manifestBytes = readFileSync(join(packageRoot, "package.json"));
		const manifest = JSON.parse(manifestBytes.toString("utf8"));
		if (manifest.name !== name || manifest.version !== version) throw new Error(`Official cohort version mismatch: ${name}`);
		const provenance = lock.packages[packageKey];
		assertIntegrity(provenance, name, version);
		const dependencies = Object.fromEntries(Object.entries({ ...manifest.dependencies, ...manifest.optionalDependencies }).filter(([dependency]) => dependency.startsWith("@earendil-works/")));
		for (const [dependency, requested] of Object.entries(dependencies)) {
			if (!cohort.has(dependency) || ![version, `^${version}`, `~${version}`].includes(requested)) {
				throw new Error(`Unreviewed official runtime dependency: ${name} -> ${dependency}`);
			}
		}
		if (!existsSync(join(packageRoot, "dist/index.js"))) throw new Error(`Missing official package entry: ${name}`);
		packages.push({ name, version, integrity: provenance.integrity, resolved: provenance.resolved, manifestSha256: sha256(manifestBytes), dependencies });
	}
	// A top-level exact pin is insufficient when a nested Pi copy still resolves
	// to a newer version. Inspect every recorded official runtime package.
	for (const [key, record] of Object.entries(lock.packages)) {
		const match = key.match(/(?:^|\/)node_modules\/(\@earendil-works\/[^/]+)$/);
		if (!match) continue;
		if (!cohort.has(match[1])) throw new Error(`Unreviewed installed official package: ${match[1]}`);
		assertIntegrity(record, match[1], version);
		if (key !== `node_modules/${match[1]}`) throw new Error(`Nested official cohort copy: ${match[1]}`);
	}
	if (!existsSync(join(directory, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"))) throw new Error("Missing official Pi CLI");
	return { host: "official npm Pi", version, packages, installManifestSha256: sha256(readFileSync(join(directory, "package.json"))), lockSha256: sha256(lockBytes) };
}

export function officialPiReady(stockRoot, version) {
	try {
		inspectOfficialPi(stockRoot, version);
		return true;
	} catch {
		return false;
	}
}

function assertIsolatedInstallTarget(directory) {
	const manifestFile = join(directory, "package.json");
	if (!existsSync(manifestFile)) return;
	const manifest = readJson(manifestFile);
	if (manifest.workspaces || manifest.overrides || manifest.scripts || Object.keys(manifest.dependencies ?? {}).some((name) => !cohort.has(name)) || Object.keys(manifest.devDependencies ?? {}).length) {
		throw new Error("Refusing to install official Pi into an unrelated project");
	}
}

function successful(result, operation) {
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${operation} failed (exit ${result.status ?? result.signal ?? "unknown"}): ${String(result.stderr ?? "").slice(-2000)}`);
	return result;
}

export function installOfficialPi(options, run = spawnSync) {
	const version = checkedVersion(options.version);
	const directory = resolve(options.stockRoot);
	let installed = false;
	if (!officialPiReady(directory, version)) {
		if (options.check) return inspectOfficialPi(directory, version);
		assertIsolatedInstallTarget(directory);
		mkdirSync(directory, { recursive: true });
		successful(run("npm", ["install", "--prefix", directory, "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=true", "--save-exact", "--fetch-timeout=30000", "--fetch-retries=0", ...OFFICIAL_PI_COHORT.map((name) => `${name}@${version}`)], {
			cwd: directory, env: process.env, encoding: "utf8", timeout: 180_000, maxBuffer: 4 * 1024 * 1024,
		}), "Official cohort installation");
		installed = true;
	}
	const report = inspectOfficialPi(directory, version);
	const sdkFile = pathToFileURL(join(directory, "node_modules/@earendil-works/pi-coding-agent/dist/index.js")).href;
	const code = `const sdk = await import(${JSON.stringify(sdkFile)}); if (sdk.VERSION !== ${JSON.stringify(version)} || typeof sdk.createAgentSession !== "function" || typeof sdk.SessionManager !== "function") throw new Error("OFFICIAL_PI_SDK_MISMATCH"); process.stdout.write("official-sdk-ready\\n");`;
	const probe = successful(run(process.execPath, ["--import", fileURLToPath(new URL("../eval/deny-network.mjs", import.meta.url)), "--input-type=module", "--eval", code], {
		cwd: directory, env: { ...process.env, PI_CODING_AGENT_DIR: join(directory, ".sdk-probe-agent"), PI_OFFLINE: "1", EVAL_PROVIDER_MODE: "scripted", EVAL_MODEL_CALL_BUDGET: "0", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" }, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024,
	}), "Network-blocked official SDK startup");
	if (probe.stdout.trim() !== "official-sdk-ready") throw new Error("Official SDK startup probe did not confirm readiness");
	return { ...report, installed, sdkStartup: "network-blocked import passed" };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		if (process.argv.length === 3 && process.argv[2] === "--help") console.log(usage);
		else console.log(JSON.stringify(installOfficialPi(parseStockInstallArguments(process.argv.slice(2))), null, 2));
	} catch (error) {
		console.error(error.message);
		process.exitCode = error.message === usage || error.message.startsWith("Unsupported official Pi version:") ? 2 : 1;
	}
}

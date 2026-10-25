/**
 * The host-neutral core's two mechanical gates (v0.7.0 plan, WP1).
 *
 * 1. Import gate: every import specifier reachable from packages/compaction-core — type-only
 *    imports, re-exports and dynamic imports included — must be relative and stay inside the
 *    package, `node:*`, or TypeBox. Anything else fails, explicitly including any
 *    `@earendil-works/*` specifier and any relative path that escapes the package (for example
 *    into packages/coding-agent/src). `require(x)` and `process.getBuiltinModule(x)` count as
 *    imports, a specifier that is not a literal fails, and so does `node:module`, which loads
 *    modules by name where the gate cannot follow. Test files may additionally import the
 *    repository's test runner, which is never bundled. Modeled on the preview builder's input
 *    and external-import allowlists in context-memory-preview-build.mjs, with the Pi peers
 *    removed.
 * 2. Isolation check: the core is copied to a temporary directory where no `@earendil-works/*`
 *    package resolves, built with tsc, and its tests run there — the roadmap's "builds and tests
 *    without Pi packages" made mechanical, in the manner of the stock-Pi acceptance's temporary
 *    directories. Offline: only files already in this repository's node_modules are used.
 *
 * The core starts from a byte-for-byte copy of the resident identity.ts (design rule K9); the
 * copy-synchronization check fails if either side drifts.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const CORE_PACKAGE = "packages/compaction-core";
export const RESIDENT_IDENTITY = "packages/coding-agent/src/extensions/context-memory/identity.ts";
// spec/ is the specification (documentation under maintainer review), never scanned or copied.
const ignoredDirectories = new Set([".git", "coverage", "dist", "node_modules", "spec"]);
const hostScope = "@earendil-works/";

export function collectCoreFiles(directory) {
	const files = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			if (!ignoredDirectories.has(entry.name)) files.push(...collectCoreFiles(path));
		} else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
			files.push(path);
		}
	}
	return files.sort();
}

/**
 * The parser loads lazily so that context-memory-ops.mjs (which imports this module for doctor)
 * still starts on a fresh clone whose dependencies are not installed yet.
 */
async function loadParser() {
	const [{ SyntaxKind }, predicates, { API }] = await Promise.all([
		import("typescript/unstable/ast"),
		import("typescript/unstable/ast/is"),
		import("typescript/unstable/sync"),
	]);
	return { SyntaxKind, predicates, API };
}

function rejection(specifier, file, packageRoot) {
	// createRequire and register load a module from a name computed at run time.
	if (specifier === "node:module") return "loads modules by name where the gate cannot follow";
	if (specifier.startsWith("node:")) return undefined;
	if (specifier === "typebox" || specifier.startsWith("typebox/")) return undefined;
	// The repository's test runner is allowed in test files only; it is never bundled or shipped.
	if (specifier === "vitest" && relative(packageRoot, file).split(sep)[0] === "test") return undefined;
	if (specifier.startsWith("./") || specifier.startsWith("../")) {
		const target = resolve(dirname(file), specifier);
		const contained = relative(packageRoot, target);
		if (contained !== "" && !contained.startsWith("..") && !isAbsolute(contained)) return undefined;
		return "relative import escapes the core package";
	}
	if (specifier.startsWith(hostScope)) return "host package import";
	return "not relative-in-package, node:*, or typebox";
}

/** Every disallowed import specifier reachable from the core package, type-only positions included. */
export async function coreImportViolations(packageRoot) {
	const files = collectCoreFiles(packageRoot);
	if (files.length === 0) return [`${relative(process.cwd(), packageRoot) || packageRoot}: no TypeScript sources found`];
	const failures = [];
	const { SyntaxKind, predicates, API } = await loadParser();
	const isStringLiteralLike = (node) =>
		node !== undefined && (predicates.isStringLiteral(node) || predicates.isNoSubstitutionTemplateLiteral(node));
	// import(x), require(x) and process.getBuiltinModule(x), destructured or not, all load a module by name.
	const loadsModule = (callee) =>
		callee.kind === SyntaxKind.ImportKeyword ||
		(predicates.isIdentifier(callee) && (callee.text === "require" || callee.text === "getBuiltinModule")) ||
		(predicates.isPropertyAccessExpression(callee) && callee.name.text === "getBuiltinModule");
	// Parse every file through one synthetic project. noResolve keeps the program to exactly these files.
	const configPath = resolve(packageRoot, "tsconfig.core-import-gate.json");
	const config = JSON.stringify({ compilerOptions: { noResolve: true, noLib: true, types: [] }, files });
	const api = new API({
		cwd: packageRoot,
		fs: {
			fileExists: (fileName) => (resolve(fileName) === configPath ? true : undefined),
			readFile: (fileName) => (resolve(fileName) === configPath ? config : undefined),
		},
	});
	try {
		const program = api.updateSnapshot({ openProjects: [configPath] }).getProject(configPath).program;
		for (const file of files) {
			const sourceFile = program.getSourceFile(resolve(file));

			function fail(node, message) {
				const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
				failures.push(`${relative(packageRoot, file)}:${line + 1}:${character + 1}: ${message}`);
			}

			function checkSpecifier(node) {
				const reason = rejection(node.text, file, packageRoot);
				if (reason) fail(node, `${node.text} (${reason})`);
			}

			function visit(node) {
				if (predicates.isImportDeclaration(node) && isStringLiteralLike(node.moduleSpecifier)) {
					checkSpecifier(node.moduleSpecifier);
				} else if (predicates.isExportDeclaration(node) && isStringLiteralLike(node.moduleSpecifier)) {
					checkSpecifier(node.moduleSpecifier);
				} else if (predicates.isCallExpression(node) && loadsModule(node.expression)) {
					// A specifier that is not a literal cannot be checked statically, so it fails closed.
					const specifier = node.arguments[0];
					if (isStringLiteralLike(specifier)) checkSpecifier(specifier);
					else fail(node, `${node.getText(sourceFile)} (module specifier is not a literal)`);
				} else if (predicates.isImportTypeNode(node)) {
					if (predicates.isLiteralTypeNode(node.argument) && isStringLiteralLike(node.argument.literal)) {
						checkSpecifier(node.argument.literal);
					}
				}
				node.forEachChild(visit);
			}

			visit(sourceFile);
		}
	} finally {
		api.close();
	}
	return failures;
}

/** K9: the core's identity.ts is a byte-for-byte copy of the resident file; neither side may drift. */
export function coreIdentitySynchronized(root) {
	const core = join(root, CORE_PACKAGE, "src/identity.ts");
	const resident = join(root, RESIDENT_IDENTITY);
	return existsSync(core) && existsSync(resident) && readFileSync(core).equals(readFileSync(resident));
}

/** Directories whose node_modules Node and the test runner would consult from `start` upward. */
function hostPackagesResolvableFrom(start) {
	const findings = [];
	let directory = start;
	while (true) {
		const scope = join(directory, "node_modules", hostScope.slice(0, -1));
		if (existsSync(scope)) findings.push(scope);
		const parent = dirname(directory);
		if (parent === directory) return findings;
		directory = parent;
	}
}

function run(name, program, args, options) {
	const result = spawnSync(program, args, { stdio: "inherit", ...options });
	if (result.error) throw result.error;
	if (result.status !== 0) {
		console.error(`core-check: ${name} failed (exit ${result.status})`);
		process.exit(result.status ?? 1);
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const root = fileURLToPath(new URL("../", import.meta.url));
	const packageRoot = resolve(root, CORE_PACKAGE);
	const environment = { ...process.env, PI_OFFLINE: "1" };
	delete environment.NODE_PATH;
	delete environment.NODE_OPTIONS;

	const violations = await coreImportViolations(packageRoot);
	if (violations.length > 0) {
		console.error(`${CORE_PACKAGE} must import only relative-in-package paths, node:*, or typebox:`);
		for (const violation of violations) console.error(`  ${violation}`);
		process.exit(1);
	}
	console.log(`core-check: import gate clean (${collectCoreFiles(packageRoot).length} files)`);

	if (!coreIdentitySynchronized(root)) {
		console.error(`core-check: ${CORE_PACKAGE}/src/identity.ts is not byte-identical to ${RESIDENT_IDENTITY}`);
		process.exit(1);
	}
	console.log("core-check: identity.ts byte-identical to the resident copy");

	// --dir keeps the scan to the package's own tests; spec/ is documentation and never run.
	run("core tests (in place)", process.execPath, [resolve(root, "node_modules/vitest/dist/cli.js"), "--run", "--dir", "test"], {
		cwd: packageRoot,
		env: environment,
	});

	const temp = mkdtempSync(join(tmpdir(), "compaction-core-isolated-"));
	try {
		for (const entry of ["package.json", "tsconfig.json", "src", "test", "conformance"]) {
			cpSync(join(packageRoot, entry), join(temp, entry), { recursive: true });
		}
		for (const dependency of ["typebox", "@types/node"]) {
			cpSync(join(root, "node_modules", dependency), join(temp, "node_modules", dependency), {
				recursive: true,
				dereference: true,
			});
		}
		const reachable = hostPackagesResolvableFrom(temp);
		if (reachable.length > 0) {
			console.error(`core-check: host packages resolvable from the isolated copy:\n  ${reachable.join("\n  ")}`);
			process.exit(1);
		}
		console.log(`core-check: no ${hostScope}* package resolvable from ${temp}`);
		run("isolated build (tsc)", process.execPath, [resolve(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"], {
			cwd: temp,
			env: environment,
		});
		if (!existsSync(join(temp, "dist/identity.js")) || !existsSync(join(temp, "dist/identity.d.ts"))) {
			console.error("core-check: isolated build produced no dist/identity.js and dist/identity.d.ts");
			process.exit(1);
		}
		run("isolated tests (vitest)", process.execPath, [resolve(root, "node_modules/vitest/dist/cli.js"), "--run", "--dir", "test"], {
			cwd: temp,
			env: environment,
		});
		console.log("core-check: isolated build and tests passed without Pi packages");
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
}

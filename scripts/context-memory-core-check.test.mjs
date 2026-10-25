import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
	CORE_PACKAGE,
	collectCoreFiles,
	coreIdentitySynchronized,
	coreImportViolations,
} from "./context-memory-core-check.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

function scratch(t) {
	const directory = mkdtempSync(join(tmpdir(), "core-import-gate-test-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	mkdirSync(join(directory, "src"));
	mkdirSync(join(directory, "test"));
	writeFileSync(join(directory, "src/clean.ts"), 'import { createHash } from "node:crypto";\nimport { Type } from "typebox";\nimport { helper } from "./helper.ts";\nexport const clean = { createHash, Type, helper };\n');
	writeFileSync(join(directory, "src/helper.ts"), "export const helper = 1;\n");
	writeFileSync(join(directory, "test/clean.test.ts"), 'import { expect, it } from "vitest";\nimport { helper } from "../src/helper.ts";\nit("helper", () => expect(helper).toBe(1));\n');
	return directory;
}

test("the gate accepts a package importing only relative-in-package paths, node:*, typebox, and vitest in tests", async (t) => {
	assert.deepEqual(await coreImportViolations(scratch(t)), []);
});

test("a deliberately planted host import is rejected, in type position too", async (t) => {
	const directory = scratch(t);
	writeFileSync(
		join(directory, "src/planted.ts"),
		[
			'import type { SessionEntry } from "../../coding-agent/src/core/session-manager.ts";',
			'import { loadSdk } from "@earendil-works/pi-coding-agent";',
			'export type { AgentMessage } from "@earendil-works/pi-ai";',
			'export const lazy = () => import("@earendil-works/pi-agent-core");',
			'export type Projection = import("../../coding-agent/src/core/sdk.ts").SessionProjection;',
			"export type Planted = SessionEntry;",
			"export const planted = loadSdk;",
			"",
		].join("\n"),
	);
	const violations = await coreImportViolations(directory);
	for (const specifier of [
		"../../coding-agent/src/core/session-manager.ts",
		"@earendil-works/pi-coding-agent",
		"@earendil-works/pi-ai",
		"@earendil-works/pi-agent-core",
		"../../coding-agent/src/core/sdk.ts",
	]) {
		assert.equal(violations.filter((violation) => violation.includes(` ${specifier} `)).length, 1, specifier);
	}
	assert.equal(violations.length, 5);
});

test("dynamic imports reject specifiers that cannot be checked statically", async (t) => {
	const directory = scratch(t);
	writeFileSync(
		join(directory, "src/dynamic.ts"),
		[
			'const hostName = "@earendil-works/pi-ai";',
			'const name = "pi-ai";',
			'export const allowedLiteral = () => import("./helper.ts");',
			'export const allowedTemplate = () => import(`./helper.ts`);',
			'export const disallowedTemplate = () => import(`fs`);',
			'export const variable = () => import(hostName);',
			'export const interpolated = () => import(`@earendil-works/${name}`);',
			"",
		].join("\n"),
	);
	const violations = await coreImportViolations(directory);
	assert.deepEqual(
		violations.map((violation) => violation.replace(/^src\/dynamic\.ts:(\d+):\d+: /, "line $1: ")),
		[
			"line 5: fs (not relative-in-package, node:*, or typebox)",
			"line 6: import(hostName) (module specifier is not a literal)",
			"line 7: import(`@earendil-works/${name}`) (module specifier is not a literal)",
		],
	);
});

test("require, getBuiltinModule and node:module are checked like imports", async (t) => {
	const directory = scratch(t);
	writeFileSync(
		join(directory, "src/loaders.ts"),
		[
			'import { createRequire } from "node:module";',
			'const name = "node:module";',
			"export const viaCreateRequire = createRequire;",
			'export const viaDynamicImport = () => import("node:module");',
			'export const viaBuiltin = () => process.getBuiltinModule("node:module");',
			"export const viaBuiltinVariable = () => process.getBuiltinModule(name);",
			"const { getBuiltinModule } = process;",
			"export const viaDestructured = () => getBuiltinModule(name);",
			'export const viaRequire = () => require("@earendil-works/pi-ai");',
			'export const allowedBuiltin = () => process.getBuiltinModule("node:crypto");',
			"",
		].join("\n"),
	);
	const violations = await coreImportViolations(directory);
	assert.deepEqual(
		violations.map((violation) => violation.replace(/^src\/loaders\.ts:(\d+):\d+: /, "line $1: ")),
		[
			"line 1: node:module (loads modules by name where the gate cannot follow)",
			"line 4: node:module (loads modules by name where the gate cannot follow)",
			"line 5: node:module (loads modules by name where the gate cannot follow)",
			"line 6: process.getBuiltinModule(name) (module specifier is not a literal)",
			"line 8: getBuiltinModule(name) (module specifier is not a literal)",
			"line 9: @earendil-works/pi-ai (host package import)",
		],
	);
});

test("undeclared bare specifiers fail, including bare builtins and vitest outside test files", async (t) => {
	const directory = scratch(t);
	writeFileSync(join(directory, "src/bare.ts"), 'export { readFileSync } from "fs";\nexport { describe } from "vitest";\n');
	const violations = await coreImportViolations(directory);
	assert.equal(violations.length, 2);
	assert.ok(violations.some((violation) => violation.includes(" fs ")));
	assert.ok(violations.some((violation) => violation.includes(" vitest ")));
});

test("spec/ is documentation and is excluded from source scanning", async (t) => {
	const directory = scratch(t);
	mkdirSync(join(directory, "spec"));
	writeFileSync(join(directory, "spec/example.ts"), 'import { host } from "@earendil-works/pi-coding-agent";\nexport const example = host;\n');
	assert.deepEqual(await coreImportViolations(directory), []);
	assert.ok(collectCoreFiles(directory).every((file) => !file.includes(`${join(directory, "spec")}`)));
});

test("an empty or missing core package is itself a violation", async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "core-import-gate-empty-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	assert.equal((await coreImportViolations(directory)).length, 1);
});

test("the real core tree passes the gate and keeps identity.ts byte-identical to the resident copy", async () => {
	assert.deepEqual(await coreImportViolations(join(root, CORE_PACKAGE)), []);
	assert.ok(coreIdentitySynchronized(root));
});

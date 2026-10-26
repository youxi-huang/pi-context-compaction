import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--output-dir")) {
	throw new Error("Usage: node scripts/context-memory-adapters-build.mjs [--output-dir <directory>]");
}
const output = resolve(args[1] ?? resolve(root, ".artifacts/host-adapters"));
for (const host of ["dsh", "opencode"]) {
	const source = `packages/compaction-${host}`;
	const manifest = JSON.parse(readFileSync(resolve(root, source, "package.json"), "utf8"));
	const target = resolve(output, host);
	if (existsSync(target)) {
		const existing = JSON.parse(readFileSync(resolve(target, "package.json"), "utf8"));
		if (existing.name !== manifest.name || existing.private !== true) throw new Error("Refusing to replace an unrelated directory");
	}
	const bundled = await build({
		absWorkingDir: root,
		entryPoints: [`${source}/src/index.ts`],
		bundle: true, write: false, metafile: true,
		format: "esm", platform: "node", target: "node22", packages: "external",
		tsconfigRaw: { compilerOptions: {} },
		outfile: "dist/index.js", logLevel: "warning",
	});
	const inputs = Object.keys(bundled.metafile.inputs).sort();
	if (inputs.some((path) => !path.startsWith(`${source}/src/`) && !path.startsWith("packages/compaction-core/src/"))) {
		throw new Error("Adapter must bundle only its own source and the host-neutral core");
	}
	const peers = [...Object.keys(manifest.peerDependencies ?? {}), ...Object.keys(manifest.dependencies)];
	for (const item of Object.values(bundled.metafile.outputs).flatMap((entry) => entry.imports)) {
		if (!item.path.startsWith("node:") && !peers.some((peer) => item.path === peer || item.path.startsWith(`${peer}/`))) {
			throw new Error(`Undeclared adapter import: ${item.path}`);
		}
	}
	const hash = createHash("sha256");
	for (const file of inputs) hash.update(file).update("\0").update(readFileSync(resolve(root, file))).update("\0");
	delete manifest.devDependencies;
	manifest.main = "./dist/index.js";
	manifest.exports = { ".": "./dist/index.js" };
	manifest.files = ["dist/index.js", "README.md", "LICENSE", "adapter-build.json"];
	mkdirSync(resolve(target, "dist"), { recursive: true });
	writeFileSync(resolve(target, "dist/index.js"), bundled.outputFiles[0].contents);
	writeFileSync(resolve(target, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
	writeFileSync(resolve(target, "README.md"), readFileSync(resolve(root, "docs/context-memory/host-adapters.md")));
	writeFileSync(resolve(target, "LICENSE"), readFileSync(resolve(root, "LICENSE")));
	writeFileSync(resolve(target, "adapter-build.json"), `${JSON.stringify({ host, mode: "retrieval-only", sourceHash: hash.digest("hex"), sources: inputs }, null, 2)}\n`);
	console.log(`${host}: built independent retrieval package (${bundled.outputFiles[0].contents.length} bytes)`);
}

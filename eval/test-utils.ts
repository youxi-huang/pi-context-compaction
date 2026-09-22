import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFixture } from "./pi/offline-host.ts";

export const evalRoot = dirname(fileURLToPath(import.meta.url));
export function loadFixture(name: string) {
	return parseFixture(
		readFileSync(join(evalRoot, "fixtures", name, "session.jsonl"), "utf8"),
		JSON.parse(readFileSync(join(evalRoot, "fixtures", name, "gold.json"), "utf8")),
	);
}
export function artifactDirectory(prefix: string): string {
	const root = process.env.EVAL_ARTIFACT_DIR;
	if (!root || !root.startsWith("/")) throw new Error("EVAL_ARTIFACT_DIR required");
	mkdirSync(root, { recursive: true });
	return mkdtempSync(join(root, prefix));
}
export function json(path: string, value: unknown) {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

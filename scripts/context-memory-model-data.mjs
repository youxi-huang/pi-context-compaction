import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const cache = resolve(root, ".artifacts");
const archive = resolve(cache, "pi-0.85.1-source.tar.gz");
const expected = "f7ec92ed4f7b75369198398a3421732eae405183971450bc74cb8544f42d02ca";
mkdirSync(cache, { recursive: true });
function run(command, args) {
	const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${command} failed with status ${result.status}`);
}
if (!existsSync(archive)) {
	run("curl", ["--fail", "--location", "--retry", "2", "--output", archive,
		"https://github.com/earendil-works/pi/releases/download/v0.85.1/pi-0.85.1-source.tar.gz"]);
}
if (createHash("sha256").update(readFileSync(archive)).digest("hex") !== expected)
	throw new Error("Upstream source checksum mismatch; inspect the cached archive before retrying");
run("tar", ["-xzf", archive, "--strip-components=1", "-C", root, "pi-0.85.1/packages/ai/src/providers/data"]);
console.log("Verified and extracted the pinned upstream model data.");

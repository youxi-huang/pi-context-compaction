import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const cache = resolve(root, ".artifacts");
const archive = resolve(cache, "pi-1.1.0-source.tar.gz");
const expected = "63b17b48b855e36e64c5013523acd48131ffcfa90ae48fe2f3e6fa9fe3d0da32";
mkdirSync(cache, { recursive: true });
function run(command, args) {
	const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${command} failed with status ${result.status}`);
}
if (!existsSync(archive)) {
	run("curl", ["--fail", "--location", "--retry", "2", "--output", archive,
		"https://github.com/earendil-works/pi/releases/download/v1.1.0/pi-1.1.0-source.tar.gz"]);
}
if (createHash("sha256").update(readFileSync(archive)).digest("hex") !== expected)
	throw new Error("Upstream source checksum mismatch; inspect the cached archive before retrying");
run("tar", ["-xzf", archive, "--strip-components=1", "-C", root, "pi-1.1.0/packages/ai/src/providers/data"]);
console.log("Verified and extracted the pinned upstream model data.");

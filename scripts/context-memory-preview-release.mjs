import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const artifacts = join(root, ".artifacts");
const packageDir = join(artifacts, "context-memory-preview-package");
const repository = "youxi-huang/pi-context-compaction";
const branch = "extension-preview";
const expectedFiles = ["LICENSE", "README.md", "dist/extension.js", "package.json", "preview-build.json"].sort();
const publish = process.argv[2] === "--publish";
assert(process.argv.length === 3 && ["--prepare", "--publish"].includes(process.argv[2]), "Use --prepare or --publish");

function command(program, args, options = {}) {
	const result = spawnSync(program, args, { cwd: root, encoding: "utf8", ...options });
	if (result.error) throw result.error;
	assert.equal(result.status, 0, `${program} failed: ${result.stderr}`);
	return result.stdout.trim();
}
const git = (...args) => command("git", args);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const jsonFile = (path) => JSON.parse(readFileSync(path, "utf8"));
const manifest = jsonFile(join(packageDir, "package.json"));
const build = jsonFile(join(packageDir, "preview-build.json"));
const pack = jsonFile(join(artifacts, "context-memory-preview-package-report.json"));
const acceptance = jsonFile(join(artifacts, "context-memory-preview-acceptance", "report.json"));
assert.equal(manifest.name, "pi-context-compaction-preview");
assert(/^\d+\.\d+\.\d+$/.test(manifest.version), "Expected a reviewed release version");
const version = manifest.version;
const tag = `v${version}`;
const packageTag = `extension-v${version}`;
const sourceCommit = git("rev-parse", "HEAD");
assert.equal(git("status", "--porcelain"), "", "Release source must be clean");
assert.equal(build.sourceCommit, sourceCommit, "Rebuild from the final clean source commit");
assert.equal(pack.sourceCommit, sourceCommit);
assert.equal(build.version, version);
assert.equal(build.supportedPi, "1.1.0");
assert.equal(pack.version, version);
assert.deepEqual(pack.files.map((entry) => entry.path).sort(), expectedFiles);
assert.deepEqual(readdirSync(packageDir).sort(), ["LICENSE", "README.md", "dist", "package.json", "preview-build.json"]);
assert.deepEqual(readdirSync(join(packageDir, "dist")), ["extension.js"]);
assert.equal(manifest.pi.extensions[0], "./dist/extension.js");
assert.equal(acceptance.candidate.build, build.build);
assert.equal(acceptance.candidate.sourceHash, build.sourceHash);
assert.equal(acceptance.candidate.manifestHash, digest(readFileSync(join(packageDir, "package.json"))));
assert.equal(acceptance.candidate.entryHash, digest(readFileSync(join(packageDir, "dist/extension.js"))));
assert.equal(acceptance.candidate.buildMetadataHash, digest(readFileSync(join(packageDir, "preview-build.json"))));
assert(acceptance.assertions.length >= 26 && acceptance.assertions.every((entry) => entry.passed), "Stock-Pi acceptance must pass");
assert.equal(pack.archive, `${manifest.name}-${version}.tgz`);
assert.equal(pack.sha256, digest(readFileSync(join(artifacts, pack.archive))));

const sourceArchive = `pi-context-compaction-${tag}-source.tar.gz`;
git("archive", "--format=tar.gz", `--prefix=pi-context-compaction-${tag}/`, `--output=${join(artifacts, sourceArchive)}`, sourceCommit);
const packageFiles = expectedFiles.map((file) => ({ file, sha256: digest(readFileSync(join(packageDir, file))) }));
const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
const section = changelog.split(`## [${tag}]`)[1]?.split("\n## [")[0];
assert(section, "Release requires its own changelog section");
const notes = `Pi Context Compaction ${tag} supplies an ordinary extension for **unmodified official Pi 1.1.0**.\n\n`
	+ `Install or update the extension independently of Pi:\n\n\`\`\`sh\npi install git:github.com/${repository}@${branch}\npi update --extension git:github.com/${repository}@${branch}\n\`\`\`\n\n`
	+ `Pin the package with \`@${packageTag}\`; source tag \`${tag}\` selects the development monorepo. Restart Pi and start a fresh persistent text session.\n\n`
	+ `This pre-release supports manual compaction of completed text turns, source-linked history retrieval and explicit disk-confirmed failure recovery. Automatic compaction is cancelled and background cache warming is paused while enabled. Other checkpoint formats, parent-history grants, attachments, concurrent writers and Windows are outside its verified scope.\n\n`
	+ `Validation: 131 context checks (94 resident + 37 preview), 461 host security checks, 89 offline evaluator tests, and ${acceptance.assertions.length} actual stock-Pi package/lifecycle checks with synthetic loopback services. No real-provider quality, latency or interactive TUI claim is made.\n\n`
	+ `Source commit: ${sourceCommit}. Preview runtime: \`${build.build}\`. Resident runtime keeps its v0.3.0 fingerprint.\n\n`
	+ `[Usage and recovery](https://github.com/${repository}/blob/${tag}/docs/context-memory/extension-preview.md) · [Validation](https://github.com/${repository}/blob/${tag}/docs/context-memory/validation.md)\n\n`
	+ `### Changes\n${section.replace(/^ —[^\n]*\n/, "").trim()}\n`;
writeFileSync(join(artifacts, "context-memory-preview-release-notes.md"), notes);
const provenance = {
	version, sourceCommit, sourceTag: tag, packageTag, packageBranch: branch,
	build: build.build, sourceHash: build.sourceHash, sources: build.sources,
	supportedPi: build.supportedPi, checkpointSchema: build.checkpointSchema,
	packageFiles, stockAcceptance: { passed: acceptance.assertions.length, providers: "synthetic loopback only" },
};

async function api(path, method = "GET", body) {
	const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
		method,
		headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	if (response.status === 404 && method === "GET") return null;
	if (!response.ok) throw new Error(`GitHub ${method} ${path} failed (${response.status}): ${await response.text()}`);
	return response.json();
}

if (publish) {
	assert.equal(process.env.GITHUB_REPOSITORY, repository);
	assert.equal(process.env.GITHUB_REF_NAME, tag);
	assert(process.env.GH_TOKEN, "GitHub Actions publication token required");
	assert.equal(git("rev-parse", `${tag}^{commit}`), sourceCommit);
	git("fetch", "origin", "main");
	git("merge-base", "--is-ancestor", sourceCommit, "origin/main");
	const checks = await api(`commits/${sourceCommit}/check-runs?per_page=100`);
	for (const name of ["verify", "Analyze (actions)", "Analyze (c-cpp)", "Analyze (javascript-typescript)"]) {
		const check = checks.check_runs.find((entry) => entry.name === name && entry.app.slug === "github-actions");
		assert(check?.status === "completed" && check.conclusion === "success", `Final-commit check has not passed: ${name}`);
	}
	const runs = await api(`actions/runs?head_sha=${sourceCommit}&event=push&per_page=100`);
	for (const path of [".github/workflows/context-memory.yml", "dynamic/github-code-scanning/codeql"]) {
		assert(runs.workflow_runs.some((run) => run.head_branch === "main" && run.path === path && run.status === "completed" && run.conclusion === "success"), `Final main workflow has not passed: ${path}`);
	}
	provenance.checks = checks.check_runs.filter((entry) => entry.app.slug === "github-actions" && ["verify", "Analyze (actions)", "Analyze (c-cpp)", "Analyze (javascript-typescript)"].includes(entry.name))
		.map(({ name, conclusion, html_url }) => ({ name, conclusion, url: html_url }));
}
writeFileSync(join(artifacts, "release-provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);
const assets = [pack.archive, sourceArchive, "release-provenance.json"];
const checksums = assets.map((file) => `${digest(readFileSync(join(artifacts, file)))}  ${file}\n`).join("");
writeFileSync(join(artifacts, "SHA256SUMS"), checksums);
assets.push("SHA256SUMS");
if (!publish) {
	console.log(JSON.stringify({ version, sourceCommit, assets, packageFiles }, null, 2));
} else {
	// Stage an atomic package ref update with a separate Git index; never touch the source checkout.
	const temporary = mkdtempSync(join(artifacts, ".preview-release-"));
	try {
		const env = { ...process.env, GIT_INDEX_FILE: join(temporary, "index") };
		command("git", ["read-tree", "--empty"], { env });
		for (const file of expectedFiles) {
			const blob = git("hash-object", "-w", join(packageDir, file));
			command("git", ["update-index", "--add", "--cacheinfo", `100644,${blob},${file}`], { env });
		}
		const tree = command("git", ["write-tree"], { env });
		const remoteTag = await api(`git/ref/tags/${packageTag}`);
		const remoteBranch = await api(`git/ref/heads/${branch}`);
		let packageCommit;
		if (remoteTag) {
			assert.equal(remoteTag.object.type, "commit", "Package tag must point directly to its immutable commit");
			packageCommit = remoteTag.object.sha;
			const commit = await api(`git/commits/${packageCommit}`);
			assert.equal(commit.tree.sha, tree, "Existing package tag differs; never overwrite it");
			assert.equal(remoteBranch?.object.sha, packageCommit, "Refusing to roll back an advanced package branch");
		} else {
			if (remoteBranch) git("fetch", "origin", branch);
			const parent = remoteBranch?.object.sha ?? sourceCommit;
			const date = git("show", "-s", "--format=%cI", sourceCommit);
			packageCommit = command("git", ["commit-tree", tree, "-p", parent, "-m", `Publish extension preview ${version}\n\nSource: ${sourceCommit}\nBuild: ${build.build}`], {
				env: { ...process.env, GIT_AUTHOR_NAME: "github-actions[bot]", GIT_AUTHOR_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com", GIT_COMMITTER_NAME: "github-actions[bot]", GIT_COMMITTER_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com", GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
			});
		}
		let release = await api(`releases/tags/${tag}`);
		if (!release) {
			// The by-tag endpoint only finds published releases. Authenticated listing also finds drafts.
			const matching = [];
			for (let page = 1; ; page++) {
				const releases = await api(`releases?per_page=100&page=${page}`);
				matching.push(...releases.filter((entry) => entry.tag_name === tag));
				if (releases.length < 100) break;
			}
			assert(matching.length <= 1, "Multiple release records for the tag; resolve without overwriting assets");
			release = matching[0] ?? null;
		}
		if (!release) release = await api("releases", "POST", { tag_name: tag, target_commitish: sourceCommit, name: `${tag} — Independent extension preview for Pi 1.1.0`, body: notes, draft: true, prerelease: true, make_latest: "false" });
		assert.equal(release.prerelease, true);
		for (const file of assets) {
			const bytes = readFileSync(join(artifacts, file));
			const existing = release.assets.find((asset) => asset.name === file);
			if (existing) {
				assert.equal(existing.digest, `sha256:${digest(bytes)}`, `Existing release asset differs; never overwrite ${file}`);
				continue;
			}
			assert(release.draft, "Cannot add files to an already public release");
			const upload = release.upload_url.split("{")[0];
			assert(new URL(upload).hostname === "uploads.github.com", "Unexpected asset upload host");
			const response = await fetch(`${upload}?name=${encodeURIComponent(file)}`, { method: "POST", headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, "Content-Type": "application/octet-stream" }, body: bytes });
			assert(response.ok, `Upload failed for ${file}: ${response.status}`);
		}
		if (!remoteTag) git("push", "--atomic", "origin", `${packageCommit}:refs/heads/${branch}`, `${packageCommit}:refs/tags/${packageTag}`);
		if (release.draft) release = await api(`releases/${release.id}`, "PATCH", { draft: false });
		for (const file of assets) assert(release.assets.some((entry) => entry.name === file), `Release does not expose ${file}`);
		console.log(JSON.stringify({ version, sourceCommit, packageCommit, url: release.html_url, publishedAssets: assets }, null, 2));
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
}

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertFinalMainWorkflows, assertReleaseNotes, crossVersionChecks, hostList, minimumAcceptanceChecks, parseReviewedVersion, releaseChanges, releaseNotes, releasePiVersions, scenarioProfile } from "./context-memory-preview-release-checks.mjs";
import { assertScenarioAcceptance, OTHER_PI_VERSION } from "./context-memory-preview-acceptance-profile.mjs";

const sourceRoot = process.env.PI_CONTEXT_RELEASE_ROOT;
assert(!sourceRoot || isAbsolute(sourceRoot), "Release source root must be absolute");
const root = realpathSync(sourceRoot ?? fileURLToPath(new URL("../", import.meta.url)));
const artifacts = join(root, ".artifacts");
const packageDir = join(artifacts, "context-memory-preview-package");
const repository = "youxi-huang/slice";
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
const { version, tag, packageTag } = parseReviewedVersion(manifest.version);
const sourceCommit = git("rev-parse", "HEAD");
assert.equal(git("rev-parse", "--show-toplevel"), root, "Release source root must be the Git worktree root");
const publicationToolingCommit = process.env.PI_CONTEXT_RELEASE_TOOLING_COMMIT ?? sourceCommit;
assert.equal(git("status", "--porcelain"), "", "Release source must be clean");
assert.equal(build.sourceCommit, sourceCommit, "Rebuild from the final clean source commit");
assert.equal(pack.sourceCommit, sourceCommit);
assert.equal(build.version, version);
// The candidate's own declaration, so a retried historical tag keeps its original host contract.
const hosts = releasePiVersions(build);
assert.equal(pack.version, version);
assert.deepEqual(pack.files.map((entry) => entry.path).sort(), expectedFiles);
assert.deepEqual(readdirSync(packageDir).sort(), ["LICENSE", "README.md", "dist", "package.json", "preview-build.json"]);
assert.deepEqual(readdirSync(join(packageDir, "dist")), ["extension.js"]);
assert.equal(manifest.pi.extensions[0], "./dist/extension.js");
const expectedCandidate = { build: build.build, sourceHash: build.sourceHash,
	manifestHash: digest(readFileSync(join(packageDir, "package.json"))), entryHash: digest(readFileSync(join(packageDir, "dist/extension.js"))), buildMetadataHash: digest(readFileSync(join(packageDir, "preview-build.json"))) };
const hostAcceptance = hosts.map((host, index) => index === 0 ? acceptance : jsonFile(join(artifacts, `context-memory-preview-acceptance-${host}`, "report.json")));
for (const [index, report] of hostAcceptance.entries()) {
	assert.equal(report.stockProvenance.version, hosts[index], "Acceptance must use the required official host");
	for (const [key, value] of Object.entries(expectedCandidate)) assert.equal(report.candidate[key], value, `Acceptance candidate ${key} must match the final package`);
	assert(report.assertions.length >= minimumAcceptanceChecks(version, index === 0 ? hosts.length - 1 : 0) && report.assertions.every((entry) => entry.passed), "Stock-Pi acceptance must pass");
}
// Earlier acceptance runners recorded one compatible host; later ones list each older host.
const compatibleHosts = acceptance.compatibleHosts?.map((entry) => entry.version) ?? (acceptance.compatibleHost ? [acceptance.compatibleHost.version] : []);
assert.deepEqual(compatibleHosts, hosts.slice(1), "Primary acceptance must include cross-version checkpoints for every older supported host");
const passed = (name) => acceptance.assertions.some((entry) => entry.name === name && entry.passed);
for (const check of crossVersionChecks(hosts)) {
	assert(passed(check.older) && check.primary.some(passed), `Cross-version checkpoint checks must pass for official Pi ${check.host}`);
}
assert.equal(pack.archive, `${manifest.name}-${version}.tgz`);
assert.equal(pack.sha256, digest(readFileSync(join(artifacts, pack.archive))));

let scenarioEvidence;
const profile = scenarioProfile(version);
if (profile) {
	const reportBytes = readFileSync(join(artifacts, "context-memory-preview-scenarios", "report.json"));
	const report = JSON.parse(reportBytes.toString("utf8"));
	const scenarioManifestBytes = readFileSync(join(artifacts, "context-memory-preview-scenarios", "manifest.json"));
	const scenarioManifest = JSON.parse(scenarioManifestBytes.toString("utf8"));
	assert.deepEqual(scenarioManifest.package, build, "Scenario source identity must match the final candidate");
	assert.equal(scenarioManifest.runnerSha256, digest(readFileSync(join(root, "scripts/context-memory-preview-scenarios.mjs"))), "Scenario runner must match the final source");
	assert.equal(scenarioManifest.only, null, "Publication requires the full scenario suite");
	assert.equal(scenarioManifest.checkpointTarget, 20, "Publication requires 20 checkpoints");
	assert.equal(scenarioManifest.host.version, hosts[0]);
	assert.equal(scenarioManifest.otherHost.version, OTHER_PI_VERSION);
	const candidate = { version, sourceCommit, build: build.build, sourceHash: build.sourceHash,
		manifestHash: acceptance.candidate.manifestHash, entryHash: acceptance.candidate.entryHash, buildMetadataHash: acceptance.candidate.buildMetadataHash };
	const profileAcceptance = assertScenarioAcceptance(report, { profile, candidate, host: hosts[0] });
	if (profile === "strict") assert.deepEqual(report.knownGaps, [], `v${version} requires every scenario gate without known gaps`);
	// Content-free release evidence preserves raw grades and measurements; no source/session bodies are copied.
	scenarioEvidence = { candidate, acceptance: profileAcceptance, raw: { passed: report.passed, summary: report.summary, checks: report.checks }, reportSha256: digest(reportBytes), manifestSha256: digest(scenarioManifestBytes), runnerSha256: scenarioManifest.runnerSha256,
		performance: report.cases.filter((entry) => entry.case === "long-session-overhead").flatMap((entry) => entry.observations.filter((value) => value.step === "overhead per model request").map((value) => ({ pi: entry.pi, rows: value.rows.map((row) => {
			const measured = Object.fromEntries(["checkpoints", "sessionMB", "extensionMs", "baselineMs", "overheadMs"].map((key) => [key, row[key]]));
			assert(Object.values(measured).every((number) => typeof number === "number" && Number.isFinite(number) && number >= 0), "Performance evidence must retain numeric measurements");
			return measured;
		}) }))) };
	writeFileSync(join(artifacts, "preview-acceptance-profile.json"), `${JSON.stringify(scenarioEvidence, null, 2)}\n`);
}

const sourceArchive = `pi-context-compaction-${tag}-source.tar.gz`;
git("archive", "--format=tar.gz", `--prefix=pi-context-compaction-${tag}/`, `--output=${join(artifacts, sourceArchive)}`, sourceCommit);
const packageFiles = expectedFiles.map((file) => ({ file, sha256: digest(readFileSync(join(packageDir, file))) }));
const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
const notes = releaseNotes({
	repository, branch, tag, packageTag, sourceCommit, build: build.build, hosts,
	acceptanceChecks: hostAcceptance.reduce((sum, report) => sum + report.assertions.length, 0), changes: releaseChanges(changelog, tag, !publish),
	scenarioAcceptance: scenarioEvidence?.acceptance,
});
assertReleaseNotes(notes, { repository, packageTag, branch, hosts, scenarioAcceptance: scenarioEvidence?.acceptance });
writeFileSync(join(artifacts, "context-memory-preview-release-notes.md"), notes);
const provenance = {
	version, sourceCommit, publicationToolingCommit, sourceTag: tag, packageTag, packageBranch: branch,
	build: build.build, sourceHash: build.sourceHash, sources: build.sources,
	supportedPi: build.supportedPi, supportedPiVersions: hosts, checkpointSchema: build.checkpointSchema,
	packageFiles, stockAcceptance: { passed: hostAcceptance.reduce((sum, report) => sum + report.assertions.length, 0), hosts: hosts.map((host, index) => ({ version: host, passed: hostAcceptance[index].assertions.length })), providers: "synthetic loopback only" },
	...(scenarioEvidence ? { scenarioAcceptance: scenarioEvidence.acceptance, rawScenarioSummary: scenarioEvidence.raw.summary, scenarioReportSha256: scenarioEvidence.reportSha256 } : {}),
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
	assert.equal(process.env.PI_CONTEXT_RELEASE_TAG ?? process.env.GITHUB_REF_NAME, tag);
	assert(process.env.GH_TOKEN, "GitHub Actions publication token required");
	assert.equal(git("rev-parse", `refs/tags/${tag}^{commit}`), sourceCommit);
	git("fetch", "origin", "main");
	git("merge-base", "--is-ancestor", sourceCommit, "origin/main");
	assert(/^[0-9a-f]{40}$/.test(publicationToolingCommit), "Expected a publication tooling commit SHA");
	git("merge-base", "--is-ancestor", publicationToolingCommit, "origin/main");
	const checks = await api(`commits/${sourceCommit}/check-runs?per_page=100`);
	for (const name of ["verify", "Analyze (actions)", "Analyze (c-cpp)", "Analyze (javascript-typescript)"]) {
		const check = checks.check_runs.find((entry) => entry.name === name && entry.app.slug === "github-actions");
		assert(check?.status === "completed" && check.conclusion === "success", `Final-commit check has not passed: ${name}`);
	}
	const runs = await api(`actions/runs?head_sha=${sourceCommit}&per_page=100`);
	assertFinalMainWorkflows(runs.workflow_runs, sourceCommit);
	provenance.checks = checks.check_runs.filter((entry) => entry.app.slug === "github-actions" && ["verify", "Analyze (actions)", "Analyze (c-cpp)", "Analyze (javascript-typescript)"].includes(entry.name))
		.map(({ name, conclusion, html_url }) => ({ name, conclusion, url: html_url }));
}
writeFileSync(join(artifacts, "release-provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);
const assets = [pack.archive, sourceArchive, "release-provenance.json"];
if (scenarioEvidence) assets.push("preview-acceptance-profile.json");
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
		if (!release) release = await api("releases", "POST", { tag_name: tag, target_commitish: sourceCommit, name: `${tag}: SLICE extension preview for Pi ${hostList(hosts)}`, body: notes, draft: true, prerelease: true, make_latest: "false" });
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

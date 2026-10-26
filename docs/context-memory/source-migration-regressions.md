# Repository-source migration regressions

These tests cover the v0.7.2 change from `youxi-huang/pi-context-compaction` to
`youxi-huang/slice`. They change no package name, command, checkpoint schema,
source hash or storage path. They do not rename the repository or prepare a release.

## Run

After the normal dependency installation and offline build:

```sh
node --test scripts/context-memory-preview-source-migration.test.mjs
```

`context-memory-check.mjs` includes this command, so `context-memory-ops.mjs verify`
and CI run it. It uses the repository's actual package manager and settings
manager. It never copies their identity or deduplication algorithm into a mock.
As in `context-memory-preview-stock-install.test.mjs`, a disposable directory,
synthetic packages and the existing `eval/deny-network.mjs` isolate the test.
Git is restricted to `file` transport. Two per-process URL rewrites map the old
and new GitHub spellings to one local repository. npm has no package dependencies
to fetch, runs offline without scripts, and inherits the Node network denial.
Pi's offline flag is briefly disabled for its otherwise skipped update operation;
the independent Node and Git network guards remain active.

To run the same cases using a reviewed official host's **package-manager and
settings APIs**, install its exact cohort with the existing stock installer:

```sh
node scripts/context-memory-preview-stock-install.mjs \
  --stock-root .artifacts/stock-1.4.0 --version 1.4.0
CONTEXT_MEMORY_MIGRATION_STOCK_ROOT=.artifacts/stock-1.4.0 \
  node --test scripts/context-memory-preview-source-migration.test.mjs
```

Repeat with `1.3.0`, `1.2.0` and `1.1.0`. This route calls `inspectOfficialPi`
before importing the SDK; a mixed cohort, linked workspace host or unsupported
version fails rather than silently falling back to the repository's host.

## What is asserted

The 21 cases include both user and project scope and both an immutable synthetic
`extension-v0.7.1` tag and an advancing `extension-preview` branch. The fixture tag
uses synthetic bytes, not historical release bytes.

| Path | Assertions |
| --- | --- |
| Keep the old source | The configured address remains old; the branch advances on explicit update, the tag stays pinned; one extension resource resolves; removing the source without a ref removes its checkout and declaration. |
| Remove old, then install new | The intermediate state has no extension; the new address has a distinct checkout and a single declaration; its updates respect the ref; the same protected checkpoint validates after reopening from disk. |
| Install both by mistake | Both declarations and two resources survive resolution even with identical Git commits and manifest names; removing either address deletes only that checkout and leaves the other resolvable. |
| User/project overlap | Two refs of one repository dedupe with project precedence; two repository paths do not. Default removal affects user scope; `-l` affects project scope. Each leaves the other settings file and checkout intact. |
| Configuration | Extension configuration and session bytes are unchanged; unrelated package files, package declarations and arbitrary settings survive. Object-form package filters survive a ref change on the same identity, but are not transferred to a new identity by remove/install. |
| Recovery | A fresh session surface and failure store read the original checkpoint and source hashes. A staged durable checkpoint needs explicit recovery; an unsaved candidate cannot recover. Altering a source under the same ID or the saved candidate is rejected. A previous failure remains blocked. |
| Failed install | An unavailable new ref leaves no misleading declaration or checkout; configuration and sessions survive and a subsequent valid install can recover them. |

Recovery uses the candidate's real `assertPreviewSession`, `PreviewFailureStore`
and configuration reader, with synthetic JSONL on a public read-only session
surface. The installed package is a discovery fixture, not the extension bundle.
The tests neither invoke a writer nor assert that marker absence alone proves
checkpoint validity.

## Evidence boundaries

Record these independently; success in one row does not complete the next.

| Layer | What a pass establishes | What remains outside it |
| --- | --- | --- |
| Repository-source regression | Local aliasing, real package/settings operations, candidate recovery guards | Official Pi compatibility or real redirects |
| Official-host API regression, one result per version | Those installed package/settings APIs pass the same local cases | Loading the actual bundle from both addresses, command conflicts, concurrent handlers |
| Existing stock-Pi acceptance, one result per version | Actual built extension loaded by the official CLI/SDK, synthetic provider, checkpoint commit/reopen/recovery | This rename's end-to-end source switch and real GitHub redirects |
| Post-rename GitHub/CLI acceptance | Old and new public URLs, real clone/fetch/ref resolution and removal, protected-session reopen after the actual source switch | Real-provider quality, unless separately measured |

The post-rename run must also install both addresses and record load errors,
loaded extension paths, command/tool registration and `/compaction-doctor`
output before removing one source and reopening the protected session. Two
resolved resources in these regressions do not prove two active compaction
handlers or a runtime failure. Do not mark this gate complete from local aliasing.

The release script's `GITHUB_REPOSITORY` check still needs its separate rename
change before publishing. This test-only patch leaves it intact.

## Short user command

After the repository has been renamed **and `extension-v0.7.2` is published**,
exit the running Pi process, then run this for an ordinary global installation:

```sh
pi remove git:github.com/youxi-huang/pi-context-compaction &&
pi install git:github.com/youxi-huang/slice@extension-v0.7.2
```

For a project installation, add `-l` to both commands from that project. If both
scopes contain the old source, remove it in both scopes and reinstall only in the
intended scope. Keep any object-form package resource filters before removal
and apply them to the new entry; the two-command shortcut does not transfer them.
For the updating channel, use `@extension-preview` in the install command.

Restart Pi, reopen the existing session, and run `/compaction-doctor`. Do not
continue a protected session during the remove/install gap or after a failed
install. A pre-existing pending or failed compaction is still pending or failed;
changing the source does not authorise bypassing its recovery checks.

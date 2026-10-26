# Repository-source migration regressions

In v0.7.2 the install source moves from `youxi-huang/pi-context-compaction` to
`youxi-huang/slice`. Pi keys a Git package by host and path, so the two addresses
are two packages. These regressions show what that means for an installation
before the repository is renamed. They change no package name, command,
checkpoint format, source hash or storage path.

## Run

```sh
node --test scripts/context-memory-preview-source-migration.test.mjs
```

`context-memory-check.mjs` runs it, so `verify` and CI do too. It drives the real
package and settings managers over a local repository that both addresses alias.
Git may use only `file` transport and npm installs nothing, so nothing reaches
the network. It finishes in about ten seconds.

To use an official Pi's package and settings managers instead, install it with
the stock installer and point the test at it:

```sh
node scripts/context-memory-preview-stock-install.mjs \
  --stock-root .artifacts/stock-1.4.0 --version 1.4.0
CONTEXT_MEMORY_MIGRATION_STOCK_ROOT=.artifacts/stock-1.4.0 \
  node --test scripts/context-memory-preview-source-migration.test.mjs
```

Repeat for 1.3.0, 1.2.0 and 1.1.0. A mixed, linked or unofficial host is refused.

## What is asserted

| Case | Assertion |
| --- | --- |
| Replace, for a tag and for `extension-preview` | `pi remove` without a ref deletes the old checkout and declaration, and nothing is loaded until the new install completes. The new address gets its own checkout and one declaration. The tag stays pinned and the branch updates. |
| Both installed | Two resources resolve even with one commit and one manifest name. Removing either address leaves the other loadable. |
| Scopes | Refs of one address dedupe with project precedence, two addresses do not. Removal without `-l` touches only user scope, with `-l` only the project. |
| Resource filters | An object-form filter follows a new ref on the same address, never a new address. |
| Failed install | No declaration or checkout is left behind, and a later install succeeds. |
| Interrupted or failed compaction | Both states survive the switch, and the staged checkpoint still recovers only through its own check. |

Every operation must leave the extension configuration, the session file, other
packages and other settings untouched. Each case ends by revalidating the
checkpoint and its source hashes from disk with the candidate's own validator.
Tampering and the recovery rules themselves are covered by the preview suites;
here they are only shown to survive a reinstall. The installed package is a
discovery fixture, not the built extension.

## What this does not establish

The official-host route tests only those package and settings managers. The
built extension on each official Pi is covered by the
[stock-Pi acceptance](extension-preview.md#verification), which also removes the
package by repository whichever ref is installed. Neither can exercise GitHub's
redirect: the aliasing here is local.

That waits for the rename. After it, on every listed official Pi: clone, fetch,
update and removal through both public addresses; both addresses installed
together, with load errors, command registration and `/compaction-doctor`
recorded; then removal of one and a protected-session reopen. Before publishing,
the repository name in `scripts/context-memory-preview-release.mjs` must change,
since the publication workflow checks it against `GITHUB_REPOSITORY`.

## The user's command after the rename

Once the repository is renamed and `extension-v0.7.2` is published, exit Pi and
run, for a global installation:

```sh
pi remove git:github.com/youxi-huang/pi-context-compaction &&
pi install git:github.com/youxi-huang/slice@extension-v0.7.2
```

Add `-l` to both commands for a project installation, and use
`@extension-preview` for the updating channel. If both scopes hold the old
address, remove it from both and reinstall in one. An object-form resource
filter has to be copied to the new entry by hand.

Restart Pi, reopen the session and run `/compaction-doctor`. Do not continue a
protected session between the two commands or after a failed install. A pending
or failed compaction stays pending or failed across the switch.

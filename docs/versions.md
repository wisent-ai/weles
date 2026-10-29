# Versions

The version gate (`weles release enforce`) judges a revision against two
documents, at the release built over the accumulated commits rather than on
each push:

- `released-surface.json` — the surface of the release Stado serves, and its
  version;
- `release/version-change.json` — that release as `current`, and the version
  this tree becomes as `candidate`.

Both are written from what Stado publishes, never by hand:

```
node scripts/release/version/adopt-published.mjs --platform darwin-arm64
npm version <patch|minor|major>
node scripts/release/version/declare-candidate.mjs
```

`adopt-published` reads `stado release status weles-worker --json`, fetches
the served release's signed archive for its exact source revision with
`stado release fetch`, takes `released-surface.json` out of the runtime
payload (`runtime.binary` in `.wisent-release.json`) and records it, with the
served version as both the baseline's version and the declaration's
`current`. The archive and the extracted surface stay under
`.build/published/<product>-<version>-<platform>/`.

It refuses, naming the cause:

- a missing `--platform`;
- a status document that names no served release for that platform;
- targets that desire different releases, each named with its version and
  source revision: adopt once the rollout settles;
- a failed fetch or extraction, with the command and its error;
- a served version older than the recorded baseline, unless the baseline is
  being corrected (`weles release adopt --correcting`).

`stado release status` also exits nonzero when a target cannot be shown to run
the release it desires; that finding is about the rollout, not about what was
published, so it is repeated on stderr and the read continues.

`declare-candidate` writes the version `npm version` put into `package.json`
as the declaration's `candidate`, and refuses a `package.json` that still names
the served release.

Whether a commit's three documents agree is read without a build:

```
node scripts/release/version/disagreements.mjs --revision <commit>
```

It reads `released-surface.json`, `release/version-change.json` and
`package.json` as Git holds them at that commit and prints one line per
disagreement, nothing when they agree: `released-surface.json names <version>,
release/version-change.json's current is <version>` and `package.json names
<version>, release/version-change.json's candidate is <version>`. Naming
neither `--revision` nor `--index`, or both, a document Git cannot show (`git
show <commit>:<path> failed: <git's words>`) and a document that names no
version (`<path> at <commit> names no <field>`) are refused, exit 1.

`--index` reads the same three documents from the staged index instead of a
commit. The pre-commit hook (`.githooks/pre-commit`) runs it whenever one of
them is staged and refuses the commit with each disagreement, so a bump of
`package.json` that skipped `declare-candidate`, or a baseline written without
its current, never reaches `main`.

`tests/release/published-baseline.mjs` runs both scripts against the real
Stado in a scratch copy of the checkout under `build/real-tests/`, and checks
that the written baseline names the served version and carries the surface of
the published payload.

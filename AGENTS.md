# AGENTS.md — working rules for this repository

`dsh-tool-explorer`: a DSH plugin (host + browser halves) that manages skills and
MCP servers. These rules are the repository's operating conventions; follow them
without being asked.

## Git (maintain it as you work)

- **Commit as work completes, not once at the end.** A green `pnpm run build` or
  `pnpm test:self` run is a commit boundary. If a session is interrupted, nothing
  should be lost in the working tree.
- **Never end a task with a dirty tree.** Before reporting done: check
  `git status`, commit the intended change set, and confirm the scratch
  directories are ignored rather than untracked.
- **Message convention** (matches the existing history): `fix:`, `feat(<area>):`,
  `docs:`, `test(<area>):`, `chore:`, `ui:` followed by a concise subject.
  English and Chinese subjects both appear; pick one and stay consistent inside a
  commit. Body: what changed, why, and the evidence that it works.
- **One logical change per commit.** Do not fold unrelated doc or housekeeping
  edits into a behaviour fix.
- **Do not push, publish, or tag unless explicitly asked.** `origin/main` is a
  public repository and `npm publish` is irreversible for a version number.
- **Release flow, in order** — the README's published-version line must keep
  naming the version actually on npm until step 3:
  1. `chore: bump to X` (`package.json` only; README still names the old release)
  2. publish to npm, manually
  3. `docs: mark X as released on npm` (README + README.zh.md), then an annotated
     tag `vX` on that commit
- **Publishing details.** This machine's default registry is a mirror that cannot
  accept publishes, so every publish command pins
  `--registry=https://registry.npmjs.org`. The npm account has 2FA enabled: the
  token in the user-level `~/.npmrc` must be a granular token created with
  **Bypass two-factor authentication**, or every publish fails with `EOTP` and
  needs a live one-time password. Verify with
  `npm whoami --registry=https://registry.npmjs.org` before releasing. The token
  never enters this repository (`~/.npmrc` is outside it; a repository-local
  `.npmrc` is gitignored).

## Verify before claiming

- `pnpm run build` — `tsc` for the host, `tsdown` for the client bundle, then
  `wrap-client` + `check-client`; all four must pass.
- `pnpm test:self` — the assertion suite; it must stay fully green (the one
  stdio-probe case needs permission to spawn a child process).
- Claims about DSH behaviour must be checked against the installed package, not
  remembered: `D:\nvm\v22.19.0\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\`
  is the current first-party source of truth.

## Repository facts that bite

- `lib/` and `client/client.js` are gitignored **build outputs**. Changing `src/`
  means rebuilding; changing `dependencies` means re-packing and reinstalling —
  copying `lib/` alone is not enough.
- **Any dsh upgrade restores the official `dsh-mcp-client`** and brings the two
  reported symptoms back (console flooded with server stderr; `dsh web` never
  prints its URL line). Re-apply with `pnpm run patch:mcp`; check with
  `pnpm run patch:mcp:check` (exit 2 = patch lost). Upstream:
  deepseek-harness discussions/5129.
- The profile installs this plugin from the local tarball
  (`file:G:/dsh-tool-explorer/dsh-tool-explorer-<version>.tgz`); do not delete the
  current tarball.
- `README.md` and `README.zh.md` are translations of one another — change both.
- Scratch lives in `.tmp/` (verification homes, logs, stores) and is gitignored.
  Never `Remove-Item -Recurse` it: the isolated DSH home contains junctions into
  the global install.

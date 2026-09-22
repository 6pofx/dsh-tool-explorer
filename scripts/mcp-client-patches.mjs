/**
 * The two local `@deepseek-ai/dsh-mcp-client` patches, as data.
 *
 * Each entry is a single literal text substitution against the package's
 * shipped `lib/index.js`. They exist because the official package still has
 * neither a bounded startup wait nor a `stderr` option (checked against
 * 0.1.5-rc.2), and they are reported upstream:
 * https://github.com/deepseek-ai/deepseek-harness/discussions/5129
 *
 * Re-run them after ANY mcp-client update — npm/pnpm upgrades and `dshmarket`
 * updates both restore the official bytes.
 *
 * Both definitions carry:
 * - `marker`: a string that exists in the file only once this patch applied
 *   (the idempotency sentinel).
 * - `needle`: the exact official text being replaced. When upstream edits that
 *   region the substitution stops matching and the runner reports "the official
 *   layout changed" instead of corrupting the file.
 */

/**
 * Bound the startup wait.
 *
 * `apply()` ends with `await connection.ready`, so an unreachable or hanging
 * server keeps that loader entry pending forever; `dsh-web-app` announces the
 * `dsh web: http://…` line (and hands off the browser) only after
 * `loader.await()`, which waits for every entry. Verified present in
 * 0.1.5-rc.2 (`dsh-web-app/lib/index.js`, `announceReady`).
 *
 * The race lets `apply()` finish either way while the connection keeps working
 * in the background: tools register when they arrive (the
 * generation-replacement/re-sync path already supports that), and
 * `connectGeneration` never rejects, so the losing promise cannot surface as an
 * unhandled rejection. `failOnStartupError` still throws when the failure is
 * measurable inside the window.
 *
 * `DSH_MCP_STARTUP_TIMEOUT_MS` overrides the 3000 ms default (`0` disables the
 * bound entirely).
 */
export const PATCH_STARTUP_WAIT = {
  id: 'startup-wait',
  label: 'bound the mcp-client startup wait (a down/hanging MCP server must not block the ready line)',
  marker: 'patch-mcp-client-async',
  backupSuffix: '.async.bak',
  needle:
    '\tconst outcome = await connection.ready;\n' +
    '\tif (outcome.error !== void 0 && config.failOnStartupError) throw new Error(`mcp-client(${config.serverName}): initial connection or tool synchronization failed`, { cause: outcome.error });',
  replacement:
    '\t// Local patch (patch-mcp-client-async): bound the startup wait so a\n' +
    '\t// hanging/unreachable server cannot block dsh web from finishing boot.\n' +
    '\tconst startupWaitMs = Number.parseInt(process.env.DSH_MCP_STARTUP_TIMEOUT_MS ?? "", 10);\n' +
    '\tconst startupTimeoutMs = Number.isFinite(startupWaitMs) && startupWaitMs >= 0 ? startupWaitMs : 3000;\n' +
    '\tconst outcome = await Promise.race([\n' +
    '\t\tconnection.ready,\n' +
    '\t\tnew Promise((resolve) => setTimeout(() => resolve(null), startupTimeoutMs))\n' +
    '\t]);\n' +
    '\tif (outcome !== null && outcome.error !== void 0 && config.failOnStartupError) throw new Error(`mcp-client(${config.serverName}): initial connection or tool synchronization failed`, { cause: outcome.error });',
}

/**
 * Silence stdio server stderr.
 *
 * The `Config` schema has no `stderr` field, so the MCP SDK default (`inherit`)
 * applies and every stdio server's stderr — FastMCP banners, pino JSON lines,
 * Python tracebacks — floods `dsh web`'s console. `DSH_MCP_STDERR=inherit`
 * restores the official behavior while debugging a server.
 */
export const PATCH_STDIO_STDERR = {
  id: 'stdio-stderr',
  label: 'silence stdio MCP server stderr (banners/JSON logs must not flood the dsh console)',
  marker: 'DSH_MCP_STDERR',
  backupSuffix: '.bak',
  needle: 'env: buildChildEnv(config.env),',
  replacement: `env: buildChildEnv(config.env),
			stderr: process.env.DSH_MCP_STDERR === "inherit" ? "inherit" : "ignore",`,
}

/** Every patch, in application order. */
export const MCP_CLIENT_PATCHES = [PATCH_STDIO_STDERR, PATCH_STARTUP_WAIT]

/**
 * Apply (or check) every local `@deepseek-ai/dsh-mcp-client` patch in one run.
 *
 * These patches close two upstream gaps that resurface after every dsh /
 * mcp-client update:
 *  1. a down or hanging MCP server blocks the `dsh web: http://…` ready line
 *     (and the browser handoff) because `apply()` awaits `connection.ready`
 *     while `loader.await()` gates the announcement;
 *  2. stdio servers inherit their stderr into the dsh console, so FastMCP
 *     banners and JSON logs flood `dsh web`'s output.
 *
 * Both are idempotent and safe to re-run. Reported upstream:
 * https://github.com/deepseek-ai/deepseek-harness/discussions/5129
 *
 * Usage:
 *   node scripts/patch-mcp-client.mjs            # apply where needed
 *   node scripts/patch-mcp-client.mjs --check    # report only, exit 2 if pending
 *   node scripts/patch-mcp-client.mjs --profile webtest
 *   node scripts/patch-mcp-client.mjs --target <path/to/dsh-mcp-client/lib/index.js>
 *
 * Exit codes: 0 = all patches in place; 1 = no installation found;
 * 2 = a patch is pending or could not be written.
 */

import { runPatches } from './mcp-client-patch.mjs'
import { MCP_CLIENT_PATCHES } from './mcp-client-patches.mjs'

process.exitCode = runPatches(MCP_CLIENT_PATCHES)

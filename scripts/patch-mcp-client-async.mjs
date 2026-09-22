/**
 * Local patch: bound the mcp-client startup wait so an unreachable or hanging
 * MCP server can never block `dsh web` from finishing boot.
 *
 * Prefer `node scripts/patch-mcp-client.mjs`, which applies both local patches;
 * this entry point stays for the single-patch workflow documented earlier.
 *
 * Usage:  node scripts/patch-mcp-client-async.mjs [--profile web] [--target <path>] [--check]
 */

import { runPatches } from './mcp-client-patch.mjs'
import { PATCH_STARTUP_WAIT } from './mcp-client-patches.mjs'

process.exitCode = runPatches([PATCH_STARTUP_WAIT])

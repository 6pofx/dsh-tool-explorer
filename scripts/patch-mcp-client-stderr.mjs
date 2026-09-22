/**
 * Local patch: silence stdio MCP server stderr (startup banners, JSON logs)
 * that `@deepseek-ai/dsh-mcp-client` currently lets inherit into the dsh
 * process console.
 *
 * Prefer `node scripts/patch-mcp-client.mjs`, which applies both local patches;
 * this entry point stays for the single-patch workflow documented earlier.
 *
 * Usage:  node scripts/patch-mcp-client-stderr.mjs [--profile web] [--target <path>] [--check]
 */

import { runPatches } from './mcp-client-patch.mjs'
import { PATCH_STDIO_STDERR } from './mcp-client-patches.mjs'

process.exitCode = runPatches([PATCH_STDIO_STDERR])

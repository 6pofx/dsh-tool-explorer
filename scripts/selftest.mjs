/**
 * M1 self-test: exercises the built host modules against a mock webServer /
 * loader / tools host — patch-layer CRUD, validation, fencing, the list
 * view, and a REAL stdio probe against an in-process MCP server.
 *
 * Runs after `pnpm build`; everything is local (no profile touched).
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const lib = fileURLToPath(new URL('../lib', import.meta.url))
const { parsePatchText, insertRowBlock, overrideRowBlock, removeRowsForId, appendRowBlock } = await import(pathToFileURL(`${lib}/patch-text.js`).href)
const { testConnection, MCP_PLUGIN_NAME } = await import(pathToFileURL(`${lib}/mcp.js`).href)
const { mountRoutes } = await import(pathToFileURL(`${lib}/routes.js`).href)

let passed = 0
let failed = 0
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  ok  ${name}`)
  } else {
    failed += 1
    console.error(`  FAIL ${name} ${detail}`)
  }
}

// ---------- 1. patch-text primitives ----------
{
  console.log('patch-text primitives')
  const placeholder = '# dsh profile root …\n[]\n'
  const add = appendRowBlock(placeholder, insertRowBlock('mcp-echo', MCP_PLUGIN_NAME, { serverName: 'echo', transport: 'stdio', command: 'x' }))
  check('placeholder commented when appending', add.ok && /^# \[\].*\n- insert:/mu.test(add.text), add.ok ? '' : 'shape wrong')
  const rows = parsePatchText(add.text)
  check('appended row parses back', Array.isArray(rows) && rows.length === 1 && Array.isArray(rows[0].insert))
  const override = appendRowBlock(add.text, overrideRowBlock('mcp-echo', { serverName: 'echo', transport: 'stdio', command: 'y' }))
  check('override row parses', override.ok && parsePatchText(override.text)?.length === 2)
  const removed = removeRowsForId(override.text, 'mcp-echo')
  const afterRemove = parsePatchText(removed)
  check('remove drops every row', Array.isArray(afterRemove) && afterRemove.length === 0)
  check('placeholder restored after last row', /\[\]/u.test(removed))
  const bad = appendRowBlock('not: [a valid list', insertRowBlock('x', 'y', {}))
  check('append refused on malformed file', !bad.ok && 'reason' in bad)
}

// ---------- 2. mock host + routes ----------
const tmp = mkdtempSync(join(tmpdir(), 'dsh-te-selftest-'))
const dshHome = join(tmp, 'dsh')
const profileDir = join(dshHome, 'profiles', 'web')
mkdirSync(profileDir, { recursive: true })
const patchPath = join(profileDir, 'cordis.patch.yml')
writeFileSync(patchPath, '# template\n[]\n')

/** Mini application of patch rows to an entry list (mirrors applyEntryPatches). */
function composeRows(text) {
  const base = []
  const byId = new Map()
  const buildMap = () => { for (const e of base) byId.set(e.id, e) }
  buildMap()
  for (const row of parsePatchText(text) ?? []) {
    if (Array.isArray(row.insert)) { base.push(...row.insert); buildMap() }
    else if (typeof row.id === 'string' && row.config !== undefined) {
      const target = byId.get(row.id)
      if (target) target.config = row.config
    }
  }
  return base
}

const routes = new Map()
const host = {
  profileName: 'web',
  dshHome,
  webServer: { register: r => { routes.set(r.path, r); return () => routes.delete(r.path) } },
  loader: { entries: function* () { for (const e of composeRows(readPatch(patchPath))) yield { options: e, disabled: false, fiber: { state: 2 } } } },
  tools: { schemas: () => [ { name: 'mcp__echo__ping', description: 'ping tool', parameters: { properties: { text: {} } } } ] },
}

function readPatch(path) {
  try { return readFileSync(path, 'utf8') } catch { return '[]\n' }
}

const dispose = mountRoutes(host, () => ({ defaultSkillRoot: '~/.agents/skills', mcpConfigTarget: 'profile', previewContentLimit: 20000 }))

async function call(path, { method = 'GET', body, query = '' } = {}) {
  const route = path === '/dsh-tool-explorer/api/mcp' ? routes.get('/dsh-tool-explorer/api/mcp')
    : path.startsWith('/dsh-tool-explorer/api/mcp/') ? routes.get('/dsh-tool-explorer/api/mcp/')
    : routes.get(path)
  const req = {
    method,
    url: path + query,
    headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' },
    socket: {},
  }
  req[Symbol.asyncIterator] = async function* () { yield Buffer.from(JSON.stringify(body ?? {})) }
  const out = { status: 200, payload: null }
  const res = {
    writeHead(code) { out.status = code; return res },
    end(chunk) { try { out.payload = JSON.parse(String(chunk)) } catch { out.payload = String(chunk) } return res },
  }
  await route.handler(req, res)
  return out
}

const baseSpec = { serverName: 'echo', transport: 'stdio', command: process.execPath, args: ['--echo'], env: { TOKEN: 'x' } }

{
  console.log('routes — list / add / validation / fencing')
  const empty = await call('/dsh-tool-explorer/api/mcp')
  check('list starts empty', empty.status === 200 && empty.payload.servers.length === 0)
  check('list exposes file hashes', empty.payload.files.profile.hash !== null)

  const bad = await call('/dsh-tool-explorer/api/mcp', { method: 'POST', body: { spec: { serverName: 'bad name!', transport: 'stdio' } } })
  check('invalid spec rejected (400)', bad.status === 400)
  check('invalid spec still 400 with command missing', bad.status === 400)

  const dup = await call('/dsh-tool-explorer/api/mcp', { method: 'POST', body: { spec: baseSpec, expectedHash: empty.payload.files.profile.hash } })
  check('add succeeds', dup.status === 200 && dup.payload.id === 'mcp-echo', JSON.stringify(dup.payload))
  check('patch file got insert row', /- insert:/u.test(readPatch(patchPath)))

  const dupAgain = await call('/dsh-tool-explorer/api/mcp', { method: 'POST', body: { spec: baseSpec, expectedHash: dup.payload.files.profile.hash } })
  check('duplicate serverName rejected (409)', dupAgain.status === 409)

  const listAfter = await call('/dsh-tool-explorer/api/mcp')
  check('list shows mounted server', listAfter.payload.servers.some(s => s.id === 'mcp-echo' && s.state === 'active' && s.toolCount === 1))

  const stale = await call('/dsh-tool-explorer/api/mcp', { method: 'POST', body: { spec: { ...baseSpec, serverName: 'echo2' }, expectedHash: empty.payload.files.profile.hash } })
  check('stale fence refused (409)', stale.status === 409)

  const detail = await call('/dsh-tool-explorer/api/mcp/mcp-echo')
  check('detail returns tool inventory', detail.status === 200 && detail.payload.tools.length === 1 && detail.payload.tools[0].name === 'mcp__echo__ping')

  const edit = await call('/dsh-tool-explorer/api/mcp/mcp-echo', { method: 'PUT', body: { spec: { ...baseSpec, command: 'other' }, expectedHash: listAfter.payload.files.profile.hash } })
  check('edit succeeds', edit.status === 200, JSON.stringify(edit.payload))
  check('override row appended', /^- id: mcp-echo[\s\S]*config:/mu.test(readPatch(patchPath)) && readPatch(patchPath).trim().split(/\r?\n/).length > 4)

  const removed = await call(`/dsh-tool-explorer/api/mcp/mcp-echo`, { method: 'DELETE', query: `?layer=profile&expectedHash=${edit.payload.files.profile.hash}` })
  check('remove succeeds', removed.status === 200, JSON.stringify(removed.payload))
  const afterRemoveText = readPatch(patchPath)
  const afterRemoveRows = parsePatchText(afterRemoveText)
  check('patch rows fully removed, placeholder restored', Array.isArray(afterRemoveRows) && afterRemoveRows.length === 0 && /\[\]/u.test(afterRemoveText))
  const listGone = await call('/dsh-tool-explorer/api/mcp')
  check('list empty again', listGone.payload.servers.length === 0)
}

// ---------- 3. real stdio probe ----------
{
  console.log('routes — real stdio probe')
  // Write the server script into the workspace (.ref is gitignored) so the
  // spawned child resolves @modelcontextprotocol/sdk from workspace deps.
  const refDir = join(fileURLToPath(new URL('../', import.meta.url)), '.ref')
  mkdirSync(refDir, { recursive: true })
  const serverScript = join(refDir, 'mcp-stdio-server.mjs')
  writeFileSync(serverScript, `
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
const server = new Server({ name: 'probe-test', version: '1.0.0' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: 'ping', description: 'echo test', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }],
}))
const transport = new StdioServerTransport()
await server.connect(transport)
`)
  const result = await testConnection({ serverName: 'probe', transport: 'stdio', command: process.execPath, args: [serverScript] })
  check('probe connects and lists tools', result.ok === true && result.toolCount === 1 && result.tools.includes('ping'), JSON.stringify(result))
  const missing = await testConnection({ serverName: 'probe', transport: 'stdio' })
  check('probe without command fails cleanly', missing.ok === false && missing.error !== undefined)
}

dispose()
rmSync(tmp, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)

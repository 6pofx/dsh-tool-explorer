/**
 * M1 self-test: exercises the built host modules against a mock webServer /
 * loader / tools host — patch-layer CRUD, validation, fencing, the list
 * view, and a REAL stdio probe against an in-process MCP server.
 *
 * Runs after `pnpm build`; everything is local (no profile touched).
 */
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs'
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
    } else if (typeof row.id === 'string' && typeof row.disabled === 'boolean') {
      const target = byId.get(row.id)
      if (target) target.disabled = row.disabled
    }
  }
  return base
}

const exactRoutes = new Map()
const prefixRoutes = new Map()

// --- mock skills registry: scans a tmp agents home, mirrors the provider ---
const agentsHome = join(tmp, 'agentsHome')
const userSkillsRoot = join(agentsHome, 'skills')
mkdirSync(join(userSkillsRoot, 'echo-skill'), { recursive: true })
writeFileSync(join(userSkillsRoot, 'echo-skill', 'SKILL.md'), '---\nname: echo-skill\ndescription: Echo test skill\n---\n\n# Echo\nHello\n')
writeFileSync(join(agentsHome, '.skill-lock.json'), JSON.stringify({
  version: 3,
  skills: { 'echo-skill': { source: 'vercel-labs/skills', sourceType: 'github', sourceUrl: 'https://github.com/vercel-labs/skills.git', skillPath: 'skills/echo-skill/SKILL.md', skillFolderHash: 'abc', installedAt: '2026-08-30T00:00:00.000Z', updatedAt: '2026-08-30T00:00:00.000Z' } },
}))

const { load: yamlLoad } = await import('js-yaml')

function parseFrontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text)
  const raw = match === null ? '' : match[1]
  let frontmatter = parsePatchText(raw) ?? yamlLoad(raw) ?? {}
  if (typeof frontmatter !== 'object' || Array.isArray(frontmatter)) frontmatter = {}
  return { frontmatter, body: match === null ? text : text.slice(match[0].length).trim() }
}

function mockSkillsList() {
  const out = []
  for (const dir of readdirSyncSafe(userSkillsRoot)) {
    const file = join(userSkillsRoot, dir, 'SKILL.md')
    if (!existsSyncSafe(file)) continue
    const parsed = parseFrontmatter(readFileSync(file, 'utf8'))
    const fm = parsed.frontmatter ?? {}
    out.push({
      name: fm.name ?? dir,
      description: typeof fm.description === 'string' ? fm.description : '',
      whenToUse: typeof fm['whenToUse'] === 'string' ? fm['whenToUse'] : undefined,
      invocation: {
        modelInvocable: fm['disable-model-invocation'] !== true,
        userInvocable: fm['user-invocable'] !== false,
      },
      source: 'user-agents',
      provider: 'filesystem',
    })
  }
  out.push({
    name: 'runtime-sample',
    description: 'A plugin-provided skill',
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'runtime',
    provider: 'some-plugin',
  })
  return out
}

function mockSkillsGet(name) {
  if (name === 'runtime-sample') {
    return { name, description: 'A plugin-provided skill', content: '# Runtime\nbody', invocation: { modelInvocable: true, userInvocable: true }, source: 'runtime', provider: 'some-plugin' }
  }
  const file = join(userSkillsRoot, name, 'SKILL.md')
  if (!existsSyncSafe(file)) return undefined
  const parsed = parseFrontmatter(readFileSync(file, 'utf8'))
  const fm = parsed.frontmatter ?? {}
  return {
    name: fm.name ?? name,
    description: typeof fm.description === 'string' ? fm.description : '',
    whenToUse: typeof fm['whenToUse'] === 'string' ? fm['whenToUse'] : undefined,
    content: parsed.body,
    path: file,
    invocation: {
      modelInvocable: fm['disable-model-invocation'] !== true,
      userInvocable: fm['user-invocable'] !== false,
    },
    source: 'user-agents',
    provider: 'filesystem',
  }
}

function readdirSyncSafe(path) {
  try { return readdirSync(path, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name) } catch { return [] }
}
function existsSyncSafe(path) {
  try { return existsSync(path) } catch { return false }
}

const host = {
  profileName: 'web',
  dshHome,
  agentsHome,
  webServer: {
    register: r => {
      const table = r.kind === 'exact' ? exactRoutes : prefixRoutes
      if (table.has(r.path)) throw new Error(`duplicate ${r.kind} route ${r.path}`)
      table.set(r.path, r)
      return () => table.delete(r.path)
    },
  },
  loader: { entries: function* () { for (const e of composeRows(readPatch(patchPath))) yield { options: e, disabled: false, fiber: { state: 2 } } } },
  tools: { schemas: () => [ { name: 'mcp__echo__ping', description: 'ping tool', parameters: { properties: { text: {} } } } ] },
  skills: {
    list: async lookup => {
      lastSkillLookup = lookup ?? {}
      return mockSkillsList()
    },
    get: async name => mockSkillsGet(name),
  },
  // A live agent enables the agent-scope skill view (web presets hold the
  // filesystem provider). Lazy lookup, exactly like the real host wiring.
  agentsLookup: () => ({
    list: () => [
      { id: 'agent-demo', status: 'idle' },
      { id: 'agent-live', status: 'running' },
    ],
    get: id => id === 'agent-live' ? { name: 'agent-live' } : undefined,
  }),
}
let lastSkillLookup = {}

function readPatch(path) {
  try { return readFileSync(path, 'utf8') } catch { return '[]\n' }
}

const dispose = mountRoutes(host, () => ({ defaultSkillRoot: '~/.agents/skills', mcpConfigTarget: 'profile', previewContentLimit: 20000 }))

async function call(path, { method = 'GET', body, query = '' } = {}) {
  // Mirrors webServer dispatch: exact by pathname, then the longest prefix
  // whose `prefix + '/'` matches the pathname.
  const exact = exactRoutes.get(path)
  let best
  for (const [prefix, route] of prefixRoutes) {
    if (path !== prefix && !path.startsWith(prefix + '/')) continue
    if (best === undefined || prefix.length > best[0].length) best = [prefix, route]
  }
  const route = exact ?? best?.[1]
  if (route === undefined) throw new Error(`no route registered for ${path}`)
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

  // --- enable/disable toggle ---
  const off = await call(`/dsh-tool-explorer/api/mcp/mcp-echo/toggle`, { method: 'POST', body: { enabled: false }, query: `?layer=profile&expectedHash=${edit.payload.files.profile.hash}` })
  check('toggle disable succeeds', off.status === 200, JSON.stringify(off.payload))
  check('disabled row written', /^- id: mcp-echo\r?\n  disabled: true/mu.test(readPatch(patchPath)))
  check('list reflects disabled', off.payload.servers.find(s => s.id === 'mcp-echo')?.state === 'disabled')
  const on = await call(`/dsh-tool-explorer/api/mcp/mcp-echo/toggle`, { method: 'POST', body: { enabled: true }, query: `?layer=profile&expectedHash=${off.payload.files.profile.hash}` })
  check('toggle enable succeeds', on.status === 200 && on.payload.servers.find(s => s.id === 'mcp-echo')?.state === 'active', JSON.stringify(on.payload))
  check('disabled row removed on enable', !/^- id: mcp-echo\r?\n  disabled: true/mu.test(readPatch(patchPath)))

  const removed = await call(`/dsh-tool-explorer/api/mcp/mcp-echo`, { method: 'DELETE', query: `?layer=profile&expectedHash=${on.payload.files.profile.hash}` })
  check('remove succeeds', removed.status === 200, JSON.stringify(removed.payload))
  const afterRemoveText = readPatch(patchPath)
  const afterRemoveRows = parsePatchText(afterRemoveText)
  check('patch rows fully removed, placeholder restored', Array.isArray(afterRemoveRows) && afterRemoveRows.length === 0 && /\[\]/u.test(afterRemoveText))
  const listGone = await call('/dsh-tool-explorer/api/mcp')
  check('list empty again', listGone.payload.servers.length === 0)
}

// ---------- 3. cross-agent import ----------
{
  console.log('routes — cross-agent import')
  const { scanAgentMcpSources, normalizeServerName } = await import(pathToFileURL(`${lib}/agents-mcp.js`).href)
  check('normalize: spaces become dashes', normalizeServerName('Everything Server') === 'everything-server')
  check('normalize: long names truncated', (normalizeServerName('a'.repeat(40)) ?? '').length <= 32)
  check('normalize: empty rejected', normalizeServerName('!!!') === null)

  const agentHome = join(tmp, 'agent-home')
  mkdirSync(agentHome, { recursive: true })
  mkdirSync(join(agentHome, '.codex'), { recursive: true })
  mkdirSync(join(agentHome, '.cursor'), { recursive: true })
  writeFileSync(join(agentHome, '.codex', 'config.toml'), [
    '[mcp_servers.Everything Server]',
    'command = "npx"',
    'args = ["-y", "@modelcontextprotocol/server-everything"]',
    'env = { API_KEY = "x", PORT = 8080 }',
    '',
    '[mcp_servers.remote-http]',
    'url = "https://mcp.example.com/mcp"',
    'headers = { Authorization = "Bearer t" }',
  ].join('\n'))
  writeFileSync(join(agentHome, '.cursor', 'mcp.json'), JSON.stringify({
    mcpServers: { Filesystem: { command: 'node', args: ['/tmp/fs.js'] } },
  }))

  const previousHome = process.env.DSH_TE_AGENT_HOME
  process.env.DSH_TE_AGENT_HOME = agentHome
  const sources = scanAgentMcpSources()
  const codex = sources.find(source => source.agent === 'codex' && source.exists)
  check('codex toml scanned', codex !== undefined && codex.servers.length === 2, JSON.stringify(codex?.servers))
  const everything = codex?.servers.find(server => server.name === 'Everything Server')
  check('toml inline table parsed', everything !== undefined && everything.env?.API_KEY === 'x' && everything.env?.PORT === '8080')
  check('toml http server parsed', codex?.servers.some(server => server.name === 'remote-http' && server.url !== undefined))
  const cursor = sources.find(source => source.agent === 'cursor' && source.exists)
  check('cursor json scanned', cursor !== undefined && cursor.servers.length === 1)

  const listBefore = await call('/dsh-tool-explorer/api/mcp')
  const importRes = await call('/dsh-tool-explorer/api/mcp/import', {
    method: 'POST',
    body: {
      selections: [
        { path: join(agentHome, '.codex', 'config.toml'), name: 'Everything Server' },
        { path: join(agentHome, '.codex', 'config.toml'), name: 'remote-http' },
      ],
      layer: 'profile',
      expectedHash: listBefore.payload.files.profile.hash,
    },
  })
  check('import returns 200', importRes.status === 200, JSON.stringify(importRes.payload))
  check('import converts names', importRes.payload.imported.length === 2
    && importRes.payload.imported.some(item => item.name === 'everything-server')
    && importRes.payload.imported.some(item => item.name === 'remote-http'))
  const listAfterImport = await call('/dsh-tool-explorer/api/mcp')
  check('imported servers appear (patch rows)', listAfterImport.payload.servers.length === 2)
  const dupImport = await call('/dsh-tool-explorer/api/mcp/import', {
    method: 'POST',
    body: { selections: [{ path: join(agentHome, '.codex', 'config.toml'), name: 'Everything Server' }], layer: 'profile', expectedHash: listAfterImport.payload.files.profile.hash },
  })
  check('re-import hits conflict and skips', dupImport.status === 200 && dupImport.payload.skipped.length === 1 && dupImport.payload.imported.length === 0)

  for (const row of ['mcp-everything-server', 'mcp-remote-http']) {
    const list = await call('/dsh-tool-explorer/api/mcp')
    await call(`/dsh-tool-explorer/api/mcp/${row}`, { method: 'DELETE', query: `?layer=profile&expectedHash=${list.payload.files.profile.hash}` })
  }
  process.env.DSH_TE_AGENT_HOME = previousHome ?? ''
}

// ---------- 4. skills ----------
{
  console.log('routes — skills list / create / toggle / rename')
  const list = await call('/dsh-tool-explorer/api/skills')
  check('skills list includes user + runtime', list.status === 200 && list.payload.skills.length === 2, JSON.stringify(list.payload))
  check('agent scope resolution: lookup carries the live agent scope', lastSkillLookup.scope?.name === 'agent-live')
  check('viewScope is agent when a live agent exists', list.payload.viewScope === 'agent')
  const echo = list.payload.skills.find(item => item.name === 'echo-skill')
  check('user skill carries path + lock + editable', echo !== undefined && echo.editable && echo.managed && echo.path?.endsWith('SKILL.md'))
  check('lock info merged', echo.lock?.sourceUrl === 'https://github.com/vercel-labs/skills.git')
  const runtime = list.payload.skills.find(item => item.name === 'runtime-sample')
  check('runtime skill read-only', runtime !== undefined && runtime.editable === false)

  const bad = await call('/dsh-tool-explorer/api/skills', { method: 'POST', body: { name: 'Bad Name!', description: 'x' } })
  check('invalid name rejected (400)', bad.status === 400)
  const noDesc = await call('/dsh-tool-explorer/api/skills', { method: 'POST', body: { name: 'ok-name' } })
  check('missing description rejected (400)', noDesc.status === 400)

  const created = await call('/dsh-tool-explorer/api/skills', {
    method: 'POST',
    body: { root: '~/.agents/skills', name: 'my-new', description: 'A brand new skill', whenToUse: 'always', modelInvocable: true, userInvocable: true, body: '# Hello\nWorld' },
  })
  check('create succeeds', created.status === 200, JSON.stringify(created.payload))
  const newFile = join(userSkillsRoot, 'my-new', 'SKILL.md')
  check('skill file written', existsSync(newFile))
  const newText = readFileSync(newFile, 'utf8')
  check('frontmatter serialized', /^---\nname: my-new\n/mu.test(newText) && newText.includes('# Hello'))
  check('created skill appears in list', created.payload.skills.some(item => item.name === 'my-new'))

  const toggled = await call('/dsh-tool-explorer/api/skills/my-new/toggle', { method: 'POST', body: { enabled: false } })
  check('toggle disable succeeds', toggled.status === 200)
  const toggledText = readFileSync(newFile, 'utf8')
  check('dual flags written', toggledText.includes('disable-model-invocation: true') && toggledText.includes('user-invocable: false'))
  const afterToggleList = await call('/dsh-tool-explorer/api/skills')
  check('list reflects disabled', afterToggleList.payload.skills.find(item => item.name === 'my-new')?.disabled === true)

  const renamed = await call('/dsh-tool-explorer/api/skills/my-new', {
    method: 'PUT',
    body: { name: 'my-renamed', description: 'Renamed skill', whenToUse: undefined, modelInvocable: true, userInvocable: true, body: '# Renamed\ncontent' },
  })
  check('rename succeeds', renamed.status === 200, JSON.stringify(renamed.payload))
  check('old dir gone, new dir present', !existsSync(join(userSkillsRoot, 'my-new')) && existsSync(join(userSkillsRoot, 'my-renamed', 'SKILL.md')))

  const toggleBack = await call('/dsh-tool-explorer/api/skills/echo-skill/toggle', { method: 'POST', body: { enabled: false } })
  check('toggle existing skill', toggleBack.status === 200)
  const echoText = readFileSync(join(userSkillsRoot, 'echo-skill', 'SKILL.md'), 'utf8')
  check('existing skill flags written', echoText.includes('disable-model-invocation: true'))
  await call('/dsh-tool-explorer/api/skills/echo-skill/toggle', { method: 'POST', body: { enabled: true } })
  const echoText2 = readFileSync(join(userSkillsRoot, 'echo-skill', 'SKILL.md'), 'utf8')
  check('re-enable removes flags', !echoText2.includes('disable-model-invocation'))

  const detail = await call('/dsh-tool-explorer/api/skills/echo-skill')
  check('detail returns body + lock', detail.status === 200 && detail.payload.raw?.body.includes('Hello') && detail.payload.lock?.skillPath !== undefined)
  const runtimeDetail = await call('/dsh-tool-explorer/api/skills/runtime-sample')
  check('runtime detail read-only ok', runtimeDetail.status === 200 && runtimeDetail.payload.definition?.content.length > 0)

  // Regression: frontmatter with folded/block scalars must parse (the
  // JSON_SCHEMA read used to reject it and hide the description).
  const skillsModule = await import(pathToFileURL(`${lib}/skills.js`).href)
  const complexFile = join(userSkillsRoot, 'echo-skill', 'SKILL.md')
  writeFileSync(complexFile, '---\nname: echo-skill\ndescription: Echo test skill\nwhenToUse: |-\n  When the user asks\n  for an echo.\nmetadata:\n  tags: [a, b]\n---\n\n# Echo\nHello\n')
  const parsedComplex = skillsModule.readSkillFile(complexFile)
  check('block-scalar frontmatter parses', parsedComplex !== null && parsedComplex.frontmatter.description === 'Echo test skill' && String(parsedComplex.frontmatter.whenToUse).includes('asks'))
  writeFileSync(complexFile, '---\nname: echo-skill\ndescription: Echo test skill\n---\n\n# Echo\nHello\n')
}

// ---------- 4.5 git install ecosystem ----------
{
  console.log('routes — git install ecosystem')
  const { createHash } = await import('node:crypto')
  const installModule = await import(pathToFileURL(`${lib}/skills-install.js`).href)
  const { parseGitHubInput, DEFAULT_GITHUB_PROXY } = installModule

  check('parse owner/repo', parseGitHubInput('vercel-labs/skills')?.owner === 'vercel-labs')
  check('parse github url with tree path', parseGitHubInput('https://github.com/a/b/tree/main/skills/x')?.path === 'skills/x')
  check('parse branch fragment', parseGitHubInput('a/b#dev')?.branch === 'dev')
  check('reject non-github', parseGitHubInput('https://evil.com/a/b') === null)
  check('proxy prefix format', installModule.throughProxy(DEFAULT_GITHUB_PROXY, 'https://codeload.github.com/a/b/tar.gz/HEAD').startsWith('https://gh-proxy.com/https://codeload.github.com'))

  const repoBase = join(tmp, 'repo-fixture')
  const fixtureV1 = join(repoBase, 'v1', 'repo-fix')
  const fixtureV2 = join(repoBase, 'v2', 'repo-fix')
  for (const [dir, version] of [[fixtureV1, 'one'], [fixtureV2, 'two']]) {
    mkdirSync(join(dir, 'skills', 'alpha'), { recursive: true })
    mkdirSync(join(dir, 'skills', 'beta'), { recursive: true })
    mkdirSync(join(dir, '.git'), { recursive: true })
    writeFileSync(join(dir, 'README.md'), `# fix ${version}\n`)
    writeFileSync(join(dir, 'skills', 'alpha', 'SKILL.md'), `---\nname: alpha-skill\ndescription: Alpha skill v${version}\n---\n\n# Alpha\nVersion ${version}\n`)
    writeFileSync(join(dir, 'skills', 'alpha', 'hint.txt'), `hint-${version}\n`)
    writeFileSync(join(dir, 'skills', 'beta', 'SKILL.md'), '---\nname: beta-skill\ndescription: Beta skill\n---\n\n# Beta\n')
    writeFileSync(join(dir, '.git', 'junk'), 'ignored') // must be skipped by the hash
  }
  const tarModule = await import('tar')
  const tarballV1 = join(tmp, 'fix-v1.tar.gz')
  const tarballV2 = join(tmp, 'fix-v2.tar.gz')
  // codeload layout: single top-level `<repo>-<sha>/` directory.
  await tarModule.c({ gzip: true, file: tarballV1, cwd: join(repoBase, 'v1') }, ['repo-fix'])
  await tarModule.c({ gzip: true, file: tarballV2, cwd: join(repoBase, 'v2') }, ['repo-fix'])

  let currentTarball = tarballV1
  host.fetchImpl = async () => {
    const body = readFileSync(currentTarball)
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    }
  }

  const preview = await call('/dsh-tool-explorer/api/skills/install-preview', {
    method: 'POST', body: { url: 'demo/fix' },
  })
  check('preview discovers two candidates', preview.status === 200 && preview.payload.preview.candidates.length === 2, JSON.stringify(preview.payload))
  const alpha = preview.payload.preview.candidates.find((c) => c.name === 'alpha-skill')
  check('preview candidate meta', alpha !== undefined && alpha.description === 'Alpha skill vone')

  const installed = await call('/dsh-tool-explorer/api/skills/install', {
    method: 'POST',
    body: {
      target: preview.payload.preview.target,
      sourceUrl: preview.payload.preview.sourceUrl,
      candidate: alpha,
      root: '~/.agents/skills',
    },
  })
  check('install succeeds', installed.status === 200, JSON.stringify(installed.payload))
  const installedDir = join(userSkillsRoot, 'alpha-skill')
  check('skill dir created', existsSync(join(installedDir, 'SKILL.md')))
  const lockAfter = JSON.parse(readFileSync(join(agentsHome, '.skill-lock.json'), 'utf8'))
  check('lock entry written (v3 shape)', lockAfter.version === 3 && lockAfter.skills['alpha-skill']?.source === 'demo/fix'
    && lockAfter.skills['alpha-skill']?.sourceUrl === 'https://github.com/demo/fix.git'
    && lockAfter.skills['alpha-skill']?.skillPath === 'skills/alpha/SKILL.md')
  // Independent reimplementation of the CLI hash (regression guard).
  const independentHash = await (async () => {
    const { relative } = await import('node:path')
    const files = []
    const collect = (base, cur) => {
      for (const e of readdirSync(cur, { withFileTypes: true })) {
        const full = join(cur, e.name)
        if (e.isDirectory()) { if (e.name === '.git' || e.name === 'node_modules') continue; collect(base, full) }
        else if (e.isFile()) files.push({ r: relative(base, full).split('\\').join('/'), c: readFileSync(full) })
      }
    }
    collect(installedDir, installedDir)
    files.sort((a, b) => a.r.localeCompare(b.r))
    const h = createHash('sha256')
    for (const f of files) { h.update(f.r); h.update(f.c) }
    return h.digest('hex')
  })()
  check('lock hash matches independent CLI implementation', lockAfter.skills['alpha-skill']?.skillFolderHash === independentHash)

  let checkRes = await call(`/dsh-tool-explorer/api/skills/alpha-skill/check`, { method: 'POST', body: {} })
  check('check sees no update (v1)', checkRes.status === 200 && checkRes.payload.updateAvailable === false)
  currentTarball = tarballV2
  checkRes = await call(`/dsh-tool-explorer/api/skills/alpha-skill/check`, { method: 'POST', body: {} })
  check('check sees update (v2)', checkRes.status === 200 && checkRes.payload.updateAvailable === true)

  const updated = await call(`/dsh-tool-explorer/api/skills/alpha-skill/update`, { method: 'POST', body: {} })
  check('update applies v2', updated.status === 200 && updated.payload.updated === true, JSON.stringify(updated.payload))
  const updatedText = readFileSync(join(installedDir, 'SKILL.md'), 'utf8')
  check('content replaced', updatedText.includes('Version two'))
  check('backup cleaned', !existsSync(join(userSkillsRoot, '.alpha-skill.bak')))
  const lockUpdated = JSON.parse(readFileSync(join(agentsHome, '.skill-lock.json'), 'utf8'))
  check('updatedAt refreshed on update', lockUpdated.skills['alpha-skill']?.updatedAt !== lockUpdated.skills['alpha-skill']?.installedAt)

  const conflict = await call('/dsh-tool-explorer/api/skills/install', {
    method: 'POST',
    body: {
      target: preview.payload.preview.target,
      sourceUrl: preview.payload.preview.sourceUrl,
      candidate: preview.payload.preview.candidates.find((c) => c.name === 'alpha-skill'),
      root: '~/.agents/skills',
    },
  })
  check('reinstall conflicts (409)', conflict.status === 409)

  const removed = await call('/dsh-tool-explorer/api/skills/alpha-skill', { method: 'DELETE' })
  check('uninstall succeeds', removed.status === 200, JSON.stringify(removed.payload))
  check('skill dir removed', !existsSync(installedDir))
  const lockFinal = JSON.parse(readFileSync(join(agentsHome, '.skill-lock.json'), 'utf8'))
  check('lock entry removed, others kept', lockFinal.skills['alpha-skill'] === undefined && lockFinal.skills['echo-skill'] !== undefined)

  delete host.fetchImpl
}

// ---------- 5. real stdio probe ----------
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

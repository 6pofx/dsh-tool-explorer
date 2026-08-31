/**
 * The MCP tab: server list with live state + tool inventory, add/edit form,
 * one-off connection probes, cross-agent import, and removal. All host
 * communication rides fetch to /dsh-tool-explorer/api/mcp* (same origin,
 * JSON). The form is an inline panel so every color inherits the settings
 * page theme (no hard-coded surfaces).
 */

import { createElement as h, useCallback, useEffect, useState } from 'react'
import type { Translate } from './Section'

/** Wire types (structural mirrors of the host payloads). */
export interface McpSpecWire {
  serverName: string
  transport: 'stdio' | 'streamable-http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
  toolCallTimeoutMs?: number
  failOnStartupError?: boolean
  reconnect?: { enabled?: boolean; initialDelayMs?: number; maxDelayMs?: number; maxAttempts?: number }
}

export interface McpServerView {
  id: string
  serverName: string
  transport: 'stdio' | 'streamable-http'
  summary: string
  enabled: boolean
  state: string
  toolCount: number
  patchLayer: string | null
  config: McpSpecWire
}

export interface McpListPayload {
  servers: McpServerView[]
  files: {
    profile: { path: string; hash: string | null }
    home: { path: string; hash: string | null }
  }
}

export interface McpProbeResult {
  ok: boolean
  latencyMs: number
  toolCount: number
  tools: string[]
  error?: string
}

interface ImportServerWire {
  name: string
  transport: 'stdio' | 'streamable-http'
  command?: string
  url?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  headers?: Record<string, string>
  renameTo?: string
  conflict: boolean
}

interface ImportSourceWire {
  agent: string
  label: string
  path: string
  exists: boolean
  servers: ImportServerWire[]
}

const styles: Record<string, React.CSSProperties> = {
  toolbar: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 4, flexWrap: 'wrap' },
  button: {
    padding: '5px 12px', fontSize: 12, border: '1px solid rgba(128,128,128,0.4)',
    borderRadius: 4, background: 'transparent', color: 'inherit', cursor: 'pointer',
  },
  buttonPrimary: { background: 'rgba(100,140,255,0.18)', borderColor: 'rgba(100,140,255,0.6)' },
  buttonDanger: { color: '#e06666', borderColor: 'rgba(224,102,102,0.5)' },
  buttonSmall: { padding: '2px 8px', fontSize: 11 },
  panel: {
    border: '1px solid rgba(128,128,128,0.35)', borderRadius: 6, padding: '10px 12px',
    display: 'flex', flexDirection: 'column', gap: 8,
  },
  card: {
    border: '1px solid rgba(128,128,128,0.3)', borderRadius: 6, padding: '8px 12px',
    display: 'flex', flexDirection: 'column', gap: 6,
  },
  cardHead: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  name: { fontWeight: 600, fontSize: 13 },
  badge: { fontSize: 10, padding: '1px 6px', borderRadius: 8, border: '1px solid rgba(128,128,128,0.4)', opacity: 0.9 },
  muted: { fontSize: 12, opacity: 0.7 },
  actions: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' },
  result: { fontSize: 12 },
  ok: { color: '#7cc48a' },
  fail: { color: '#e06666' },
  probeDetail: { fontSize: 11, opacity: 0.75, maxWidth: 640, wordBreak: 'break-all' },
  panelTitle: { fontWeight: 600, fontSize: 13 },
  fieldRow: { display: 'flex', flexDirection: 'column', gap: 2 },
  label: { fontSize: 11, opacity: 0.75 },
  input: {
    padding: '4px 8px', fontSize: 12, border: '1px solid rgba(128,128,128,0.4)',
    borderRadius: 4, background: 'transparent', color: 'inherit', fontFamily: 'inherit',
  },
  textarea: { minHeight: 64, resize: 'vertical' },
  formButtons: { display: 'flex', gap: 8, justifyContent: 'flex-end' },
  error: { color: '#e06666', fontSize: 12, whiteSpace: 'pre-wrap' },
  tools: { borderTop: '1px solid rgba(128,128,128,0.25)', paddingTop: 6, display: 'flex', flexDirection: 'column', gap: 4 },
  toolRow: { fontSize: 11, display: 'flex', gap: 8, alignItems: 'baseline' },
  toolName: { fontFamily: 'monospace' },
  empty: { fontSize: 12, opacity: 0.6, padding: '12px 0' },
  sourceRow: { display: 'flex', flexDirection: 'column', gap: 4, borderTop: '1px solid rgba(128,128,128,0.2)', paddingTop: 6 },
  checkRow: { display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 },
}

/** Draft state of the add/edit form (key-value fields kept as text). */
interface FormDraft {
  id?: string // undefined = add
  serverName: string
  transport: 'stdio' | 'streamable-http'
  command: string
  argsText: string // one per line
  envText: string // key=value per line
  cwd: string
  url: string
  headersText: string // key=value per line
  toolCallTimeoutMs: string
  failOnStartupError: boolean
}

const emptyDraft = (): FormDraft => ({
  serverName: '', transport: 'stdio', command: 'npx', argsText: '', envText: '',
  cwd: '', url: '', headersText: '', toolCallTimeoutMs: '', failOnStartupError: false,
})

function draftFrom(view: McpServerView): FormDraft {
  const c = view.config
  return {
    id: view.id,
    serverName: c.serverName,
    transport: c.transport,
    command: c.command ?? '',
    argsText: (c.args ?? []).join('\n'),
    envText: Object.entries(c.env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n'),
    cwd: c.cwd ?? '',
    url: c.url ?? '',
    headersText: Object.entries(c.headers ?? {}).map(([k, v]) => `${k}=${v}`).join('\n'),
    toolCallTimeoutMs: c.toolCallTimeoutMs === undefined ? '' : String(c.toolCallTimeoutMs),
    failOnStartupError: c.failOnStartupError === true,
  }
}

function draftToSpec(draft: FormDraft): McpSpecWire {
  const spec: McpSpecWire = { serverName: draft.serverName.trim(), transport: draft.transport }
  const args = draft.argsText.split('\n').map(line => line.trim()).filter(Boolean)
  if (args.length > 0) spec.args = args
  const env = parseKv(draft.envText)
  if (Object.keys(env).length > 0) spec.env = env
  if (draft.command.trim() !== '') spec.command = draft.command.trim()
  if (draft.cwd.trim() !== '') spec.cwd = draft.cwd.trim()
  if (draft.url.trim() !== '') spec.url = draft.url.trim()
  const headers = parseKv(draft.headersText)
  if (Object.keys(headers).length > 0) spec.headers = headers
  const timeout = Number(draft.toolCallTimeoutMs)
  if (draft.toolCallTimeoutMs !== '' && Number.isFinite(timeout) && timeout > 0) spec.toolCallTimeoutMs = timeout
  if (draft.failOnStartupError) spec.failOnStartupError = true
  return spec
}

function parseKv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const at = trimmed.indexOf('=')
    if (at <= 0) continue
    out[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1)
  }
  return out
}

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, init)
  const body = (await response.json().catch(() => null)) as { ok?: boolean; error?: string; [key: string]: unknown } | null
  if (!response.ok || (body !== null && body.ok === false)) {
    const message = body !== null && typeof body.error === 'string' ? body.error : `HTTP ${response.status}`
    throw new Error(message)
  }
  return body
}

export function McpSection({ t }: { t: Translate }) {
  const [list, setList] = useState<McpListPayload | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [draft, setDraft] = useState<FormDraft | null>(null)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [testStates, setTestStates] = useState<Record<string, McpProbeResult | 'pending'>>({})
  const [expanded, setExpanded] = useState<Record<string, { fetching: boolean; tools: Array<{ name: string; description: string; paramCount: number }> | null; error: string | null }>>({})
  const [deleting, setDeleting] = useState<string | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [importSources, setImportSources] = useState<ImportSourceWire[] | null>(null)
  const [importBusy, setImportBusy] = useState(false)
  const [importSummary, setImportSummary] = useState<string | null>(null)
  const [importSelection, setImportSelection] = useState<Set<string>>(new Set())
  const [importError, setImportError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoadError(null)
    try {
      setList(await fetchJson('/dsh-tool-explorer/api/mcp') as McpListPayload)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  useEffect(() => { void load() }, [load])

  // Re-fetch when the page becomes visible again so the list never shows a
  // stale snapshot (dsh restarts, long idle, etc.).
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [load])

  const applyList = (payload: unknown) => {
    setList(payload as McpListPayload)
  }

  const targetHash = (): string | null | undefined => list?.files.profile.hash

  // --- import ---

  const openImport = async () => {
    setImportOpen(true)
    setImportSummary(null)
    setImportError(null)
    if (importSources === null) {
      try {
        const result = await fetchJson('/dsh-tool-explorer/api/mcp/import-sources') as { sources: ImportSourceWire[] }
        setImportSources(result.sources)
        const initial = new Set<string>()
        for (const source of result.sources) {
          for (const server of source.servers) {
            if (!server.conflict) initial.add(`${source.path}\u0000${server.name}`)
          }
        }
        setImportSelection(initial)
      } catch (error) {
        setImportError(error instanceof Error ? error.message : String(error))
      }
    }
  }

  const toggleSelection = (key: string) => {
    setImportSelection(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const runImport = async () => {
    setImportBusy(true)
    setImportSummary(null)
    setImportError(null)
    try {
      const selections: Array<{ path: string; name: string }> = []
      for (const key of importSelection) {
        const at = key.indexOf('\u0000')
        selections.push({ path: key.slice(0, at), name: key.slice(at + 1) })
      }
      const result = await fetchJson('/dsh-tool-explorer/api/mcp/import', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ selections, layer: 'profile', expectedHash: targetHash() }),
      })
      applyList(result)
      const imported = (result.imported ?? []) as Array<{ name: string }>
      const skipped = (result.skipped ?? []) as Array<{ name: string; reason: string }>
      const summary = t('importDone').replace('{n}', String(imported.length))
        + (skipped.length > 0 ? ` — ${t('importSkipped').replace('{n}', String(skipped.length))}` : '')
      setImportSummary(summary)
    } catch (error) {
      setImportError(error instanceof Error ? error.message : String(error))
    } finally {
      setImportBusy(false)
    }
  }

  // --- form ---

  const save = async () => {
    if (draft === null) return
    setSaving(true)
    setFormError(null)
    try {
      const spec = draftToSpec(draft)
      const payload = { spec, layer: 'profile', expectedHash: targetHash() }
      const result = draft.id === undefined
        ? await fetchJson('/dsh-tool-explorer/api/mcp', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
          })
        : await fetchJson(`/dsh-tool-explorer/api/mcp/${encodeURIComponent(draft.id)}`, {
            method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
          })
      applyList(result)
      setDraft(null)
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (view: McpServerView) => {
    setDeleting(view.id)
    try {
      const layerKey = view.patchLayer === 'home' ? 'home' : 'profile'
      const hash = list?.files[layerKey]?.hash
      const result = await fetchJson(`/dsh-tool-explorer/api/mcp/${encodeURIComponent(view.id)}?layer=${layerKey}&expectedHash=${encodeURIComponent(hash ?? '')}`, { method: 'DELETE' })
      applyList(result)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    } finally {
      setDeleting(null)
    }
  }

  const toggleEnabled = async (view: McpServerView) => {
    setDeleting(view.id)
    try {
      const layerKey = view.patchLayer === 'home' ? 'home' : 'profile'
      const hash = list?.files[layerKey]?.hash
      const result = await fetchJson(`/dsh-tool-explorer/api/mcp/${encodeURIComponent(view.id)}/toggle?layer=${layerKey}&expectedHash=${encodeURIComponent(hash ?? '')}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: !view.enabled }),
      })
      applyList(result)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    } finally {
      setDeleting(null)
    }
  }

  const test = async (view: McpServerView) => {
    setTestStates(prev => ({ ...prev, [view.id]: 'pending' }))
    try {
      const result = await fetchJson('/dsh-tool-explorer/api/mcp/test', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ spec: view.config }),
      }) as McpProbeResult
      setTestStates(prev => ({ ...prev, [view.id]: result }))
    } catch (error) {
      setTestStates(prev => ({ ...prev, [view.id]: { ok: false, latencyMs: 0, toolCount: 0, tools: [], error: error instanceof Error ? error.message : String(error) } }))
    }
  }

  const testDraft = async () => {
    if (draft === null) return
    setFormError(null)
    setTestStates(prev => ({ ...prev, [`draft:${draft.serverName}`]: 'pending' }))
    try {
      const result = await fetchJson('/dsh-tool-explorer/api/mcp/test', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ spec: draftToSpec(draft) }),
      }) as McpProbeResult
      setTestStates(prev => ({ ...prev, [`draft:${draft.serverName}`]: result }))
    } catch (error) {
      setTestStates(prev => ({ ...prev, [`draft:${draft.serverName}`]: { ok: false, latencyMs: 0, toolCount: 0, tools: [], error: error instanceof Error ? error.message : String(error) } }))
    }
  }

  const toggleDetail = async (view: McpServerView) => {
    const current = expanded[view.id]
    if (current !== undefined) {
      setExpanded(prev => {
        const next = { ...prev }
        delete next[view.id]
        return next
      })
      return
    }
    setExpanded(prev => ({ ...prev, [view.id]: { fetching: true, tools: null, error: null } }))
    try {
      const result = await fetchJson(`/dsh-tool-explorer/api/mcp/${encodeURIComponent(view.id)}`) as { tools?: Array<{ name: string; description: string; paramCount: number }> }
      setExpanded(prev => ({ ...prev, [view.id]: { fetching: false, tools: result.tools ?? [], error: null } }))
    } catch (error) {
      setExpanded(prev => ({ ...prev, [view.id]: { fetching: false, tools: null, error: error instanceof Error ? error.message : String(error) } }))
    }
  }

  const stateLabel = (state: string): string => {
    const key = `mcpState-${state}`
    const label = t(key)
    return label === key ? state : label
  }

  // --- render ---

  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } }, [
    h('div', { style: styles.toolbar }, [
      h('button', { style: { ...styles.button, ...styles.buttonPrimary }, onClick: () => { setDraft(emptyDraft()); setFormError(null) } }, t('mcpAdd')),
      h('button', { style: styles.button, onClick: () => void openImport() }, t('mcpImport')),
      h('button', { style: styles.button, onClick: () => void load() }, t('refresh')),
      h('span', { style: styles.muted }, t('mcpWarning')),
    ]),
    loadError === null ? null : h('div', { style: styles.error }, loadError),

    draft === null ? null : h('div', { style: styles.panel }, [
      h('div', { style: styles.panelTitle }, t(draft.id === undefined ? 'mcpAdd' : 'mcpEdit')),
      h('div', { style: { display: 'flex', gap: 12, flexWrap: 'wrap' } }, [
        h('div', { style: { ...styles.fieldRow, flex: '1 1 200px' } }, [
          h('label', { style: styles.label }, t('fServerName')),
          h('input', { style: styles.input, value: draft.serverName, disabled: draft.id !== undefined,
            onChange: (event: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, serverName: event.target.value }) }),
        ]),
        h('div', { style: { ...styles.fieldRow, flex: '0 0 180px' } }, [
          h('label', { style: styles.label }, t('fTransport')),
          h('select', { style: styles.input, value: draft.transport, onChange: (event: React.ChangeEvent<HTMLSelectElement>) => setDraft({ ...draft, transport: event.target.value as 'stdio' | 'streamable-http' }) }, [
            h('option', { value: 'stdio' }, 'stdio'),
            h('option', { value: 'streamable-http' }, 'streamable-http'),
          ]),
        ]),
      ]),
      draft.transport === 'stdio' ? [
        h('div', { style: { display: 'flex', gap: 12, flexWrap: 'wrap' } }, [
          h('div', { style: { ...styles.fieldRow, flex: '2 1 260px' } }, [
            h('label', { style: styles.label }, t('fCommand')),
            h('input', { style: styles.input, value: draft.command, onChange: (event: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, command: event.target.value }) }),
          ]),
          h('div', { style: { ...styles.fieldRow, flex: '1 1 200px' } }, [
            h('label', { style: styles.label }, t('fCwd')),
            h('input', { style: styles.input, value: draft.cwd, onChange: (event: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, cwd: event.target.value }) }),
          ]),
        ]),
        h('div', { style: { display: 'flex', gap: 12, flexWrap: 'wrap' } }, [
          h('div', { style: { ...styles.fieldRow, flex: '1 1 260px' } }, [
            h('label', { style: styles.label }, t('fArgs')),
            h('textarea', { style: { ...styles.input, ...styles.textarea }, value: draft.argsText, placeholder: '-y\n@modelcontextprotocol/server-x', onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => setDraft({ ...draft, argsText: event.target.value }) }),
          ]),
          h('div', { style: { ...styles.fieldRow, flex: '1 1 260px' } }, [
            h('label', { style: styles.label }, t('fEnv')),
            h('textarea', { style: { ...styles.input, ...styles.textarea }, value: draft.envText, placeholder: 'API_TOKEN=xxx', onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => setDraft({ ...draft, envText: event.target.value }) }),
          ]),
        ]),
      ] : [
        h('div', { style: { display: 'flex', gap: 12, flexWrap: 'wrap' } }, [
          h('div', { style: { ...styles.fieldRow, flex: '2 1 320px' } }, [
            h('label', { style: styles.label }, t('fUrl')),
            h('input', { style: styles.input, value: draft.url, placeholder: 'http://localhost:3000/mcp', onChange: (event: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, url: event.target.value }) }),
          ]),
          h('div', { style: { ...styles.fieldRow, flex: '1 1 240px' } }, [
            h('label', { style: styles.label }, t('fHeaders')),
            h('textarea', { style: { ...styles.input, ...styles.textarea, minHeight: 40 }, value: draft.headersText, placeholder: 'Authorization=Bearer xxx', onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => setDraft({ ...draft, headersText: event.target.value }) }),
          ]),
        ]),
      ],
      h('details', null, [
        h('summary', { style: styles.muted }, t('fAdvanced')),
        h('div', { style: { display: 'flex', gap: 12, flexWrap: 'wrap', paddingTop: 6 } }, [
          h('div', { style: { ...styles.fieldRow, flex: '0 1 200px' } }, [
            h('label', { style: styles.label }, t('fTimeout')),
            h('input', { style: styles.input, value: draft.toolCallTimeoutMs, placeholder: '60000', onChange: (event: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, toolCallTimeoutMs: event.target.value }) }),
          ]),
          h('label', { style: { ...styles.label, display: 'flex', gap: 6, alignItems: 'center', paddingTop: 14 } }, [
            h('input', { type: 'checkbox', checked: draft.failOnStartupError, onChange: (event: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, failOnStartupError: event.target.checked }) }),
            t('fFailStartup'),
          ]),
        ]),
      ]),
      formError === null ? null : h('div', { style: styles.error }, formError),
      h('div', { style: styles.actions }, [
        h('button', { style: { ...styles.button, ...styles.buttonSmall }, onClick: () => void testDraft(), disabled: saving }, t('mcpTest')),
        renderProbe(testStates[`draft:${draft.serverName}`], t),
        h('div', { style: { flex: 1 } }),
        h('button', { style: styles.button, onClick: () => setDraft(null), disabled: saving }, t('cancel')),
        h('button', { style: { ...styles.button, ...styles.buttonPrimary }, onClick: () => void save(), disabled: saving }, saving ? t('saving') : t('save')),
      ]),
    ]),

    importOpen ? h('div', { style: styles.panel }, [
      h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8 } }, [
        h('span', { style: styles.panelTitle }, t('mcpImport')),
        h('button', { style: { ...styles.button, ...styles.buttonSmall }, onClick: () => setImportOpen(false) }, t('cancel')),
      ]),
      importError === null ? null : h('div', { style: styles.error }, importError),
      importSummary === null ? null : h('div', { style: styles.result }, importSummary),
      importSources === null
        ? h('div', { style: styles.muted }, t('loading'))
        : importSources.length === 0
          ? h('div', { style: styles.muted }, t('importNoSources'))
          : importSources.map(source => source.servers.length === 0
            ? h('div', { key: source.path, style: styles.sourceRow }, [
                h('div', { style: styles.checkRow }, [
                  h('span', { style: { fontWeight: 600 } }, source.label),
                  h('span', { style: styles.muted }, source.exists ? t('importEmpty') : t('importMissing')),
                ]),
              ])
            : h('div', { key: source.path, style: styles.sourceRow }, [
                h('div', { style: styles.checkRow }, [
                  h('span', { style: { fontWeight: 600 } }, source.label),
                  h('span', { style: styles.muted }, `${source.servers.length} ${t('mcpTools')}`),
                ]),
                ...source.servers.map(server => {
                  const key = `${source.path}\u0000${server.name}`
                  const displayName = server.renameTo !== undefined ? `${server.name} → ${server.renameTo}` : server.name
                  return h('label', { key, style: { ...styles.checkRow, paddingLeft: 8 } }, [
                    h('input', { type: 'checkbox', checked: importSelection.has(key), disabled: server.conflict, onChange: () => toggleSelection(key) }),
                    h('span', null, displayName),
                    h('span', { style: styles.muted }, `[${server.transport}]`),
                    server.conflict ? h('span', { style: { ...styles.muted, color: '#e06666' } }, t('importConflict')) : null,
                  ])
                }),
              ])),
      importSources === null || importBusy ? null : h('div', { style: styles.actions }, [
        h('button', { style: { ...styles.button, ...styles.buttonPrimary }, onClick: () => void runImport(), disabled: importSelection.size === 0 }, t('importRun')),
      ]),
    ]) : null,

    list === null
      ? h('div', { style: styles.empty }, t('loading'))
      : list.servers.length === 0
        ? h('div', { style: styles.empty }, t('mcpEmpty'))
        : list.servers.map(view => h('div', { key: view.id, style: styles.card }, [
          h('div', { style: styles.cardHead }, [
            h('span', { style: styles.name }, view.serverName),
            h('span', { style: styles.badge }, stateLabel(view.state)),
            h('span', { style: styles.badge }, view.transport),
            h('span', { style: styles.muted }, `${t('mcpTools')}: ${view.toolCount}`),
            h('span', { style: styles.muted }, view.patchLayer === null ? '' : t('mcpLayer-' + view.patchLayer)),
          ]),
          h('div', { style: styles.muted }, view.summary),
          h('div', { style: styles.actions }, [
            h('button', { style: { ...styles.button, ...styles.buttonSmall }, onClick: () => void test(view), disabled: testStates[view.id] === 'pending' }, t('mcpTest')),
            h('button', { style: { ...styles.button, ...styles.buttonSmall }, onClick: () => { setDraft(draftFrom(view)); setFormError(null) } }, t('mcpEdit')),
            h('button', { style: { ...styles.button, ...styles.buttonSmall }, onClick: () => void toggleEnabled(view), disabled: deleting === view.id }, view.enabled ? t('mcpDisable') : t('mcpEnable')),
            h('button', { style: { ...styles.button, ...styles.buttonSmall, ...styles.buttonDanger }, onClick: () => { if (window.confirm(`${t('mcpConfirmRemove')} ${view.serverName}?`)) void remove(view) }, disabled: deleting === view.id }, t('mcpDelete')),
            h('button', { style: { ...styles.button, ...styles.buttonSmall }, onClick: () => void toggleDetail(view) }, t('mcpToolsDetail')),
          ]),
          renderProbe(testStates[view.id], t),
          renderDetail(expanded[view.id], t),
        ])),
  ])
}

function renderProbe(entry: McpProbeResult | 'pending' | undefined, t: Translate) {
  if (entry === undefined) return null
  if (entry === 'pending') return h('div', { style: styles.result }, t('mcpTesting'))
  if (entry.ok) {
    return h('div', { style: { ...styles.result, ...styles.ok } }, t('mcpTestOk').replace('{n}', String(entry.toolCount)).replace('{ms}', String(entry.latencyMs)))
  }
  return h('div', { style: { ...styles.result, ...styles.fail } }, [
    h('div', null, t('mcpTestFail')),
    h('div', { style: styles.probeDetail }, entry.error ?? ''),
  ])
}

function renderDetail(entry: { fetching: boolean; tools: Array<{ name: string; description: string; paramCount: number }> | null; error: string | null } | undefined, t: Translate) {
  if (entry === undefined) return null
  if (entry.fetching) return h('div', { style: styles.muted }, t('loading'))
  if (entry.error !== null) return h('div', { style: styles.fail }, entry.error)
  const tools = entry.tools ?? []
  return h('div', { style: styles.tools }, tools.length === 0
    ? h('div', { style: styles.muted }, t('mcpToolsEmpty'))
    : tools.map(tool => h('div', { key: tool.name, style: styles.toolRow }, [
      h('span', { style: styles.toolName }, tool.name),
      h('span', { style: styles.muted }, `${t('mcpParams')}: ${tool.paramCount}`),
      h('span', { style: styles.muted }, tool.description),
    ])))
}

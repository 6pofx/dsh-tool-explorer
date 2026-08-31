/**
 * The Skills tab: hierarchical browser over every discovered skill (registry
 * × lock file × user-root disk scan), grouped by source (project-dsh /
 * project-agents / custom / user-dsh / user-agents / runtime / bundled) and
 * provider, with search and source/status filters, detail preview, inline
 * edit/create, per-axis model/user invocation switches, and a recoverable
 * trash for deletions.
 */

import { createElement as h, useCallback, useEffect, useState } from 'react'
import type { Translate } from './Section'

interface SkillListItem {
  name: string
  description: string
  whenToUse?: string
  source: string
  provider: string
  modelInvocable: boolean
  userInvocable: boolean
  disabled: boolean
  editable: boolean
  managed: boolean
  lock?: { sourceUrl?: string; installedAt?: string; updatedAt?: string; skillPath?: string }
  path?: string
  hiddenInCatalog: boolean
}

interface SkillListPayload {
  ok: boolean
  skills: SkillListItem[]
  complete: boolean
  viewScope?: 'agent' | 'host'
  trashCount?: number
}

interface SkillDetailPayload {
  ok: boolean
  skill: SkillListItem | null
  definition: {
    name: string
    description: string
    whenToUse?: string
    content: string
    path?: string
    resourceBase?: { kind: string; path?: string; url?: string }
  } | null
  raw: { file?: string; frontmatter: Record<string, unknown>; body: string } | null
  lock: Record<string, string> | null
}

interface TrashItemView {
  id: string
  name: string
  rootLabel: string
  kind: 'bundle' | 'file'
  managed: boolean
  deletedAt: string
  exists: boolean
}

interface TrashListPayload {
  ok: boolean
  items: TrashItemView[]
}

const styles: Record<string, React.CSSProperties> = {
  toolbar: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 4, flexWrap: 'wrap' },
  search: {
    padding: '4px 8px', fontSize: 12, border: '1px solid rgba(128,128,128,0.4)', borderRadius: 4,
    background: 'transparent', color: 'inherit', fontFamily: 'inherit', minWidth: 160,
  },
  button: {
    padding: '5px 12px', fontSize: 12, border: '1px solid rgba(128,128,128,0.4)',
    borderRadius: 4, background: 'transparent', color: 'inherit', cursor: 'pointer',
  },
  buttonPrimary: { background: 'rgba(100,140,255,0.18)', borderColor: 'rgba(100,140,255,0.6)' },
  buttonDanger: { color: '#e06666', borderColor: 'rgba(224,102,102,0.5)' },
  buttonSmall: { padding: '2px 8px', fontSize: 11 },
  checkRow: { display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 },
  panel: {
    border: '1px solid rgba(128,128,128,0.35)', borderRadius: 6, padding: '10px 12px',
    display: 'flex', flexDirection: 'column', gap: 8,
  },
  panelTitle: { fontWeight: 600, fontSize: 13 },
  card: {
    border: '1px solid rgba(128,128,128,0.3)', borderRadius: 6, padding: '8px 12px',
    display: 'flex', flexDirection: 'column', gap: 6,
  },
  cardHead: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  name: { fontWeight: 600, fontSize: 13, fontFamily: 'monospace' },
  desc: { fontSize: 12, opacity: 0.8 },
  badge: { fontSize: 10, padding: '1px 6px', borderRadius: 8, border: '1px solid rgba(128,128,128,0.4)', opacity: 0.9 },
  badgeOff: { opacity: 0.55, textDecoration: 'line-through' },
  muted: { fontSize: 12, opacity: 0.7 },
  actions: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' },
  error: { color: '#e06666', fontSize: 12, whiteSpace: 'pre-wrap' },
  ok: { color: '#7cc48a', fontSize: 12 },
  fieldRow: { display: 'flex', flexDirection: 'column', gap: 2 },
  label: { fontSize: 11, opacity: 0.75 },
  input: {
    padding: '4px 8px', fontSize: 12, border: '1px solid rgba(128,128,128,0.4)',
    borderRadius: 4, background: 'transparent', color: 'inherit', fontFamily: 'inherit',
  },
  textarea: { minHeight: 96, resize: 'vertical', fontFamily: 'monospace' },
  pre: {
    fontSize: 11, opacity: 0.85, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
    maxHeight: 260, overflow: 'auto', margin: 0, fontFamily: 'monospace',
  },
  empty: { fontSize: 12, opacity: 0.6, padding: '12px 0' },
  details: { borderTop: '1px solid rgba(128,128,128,0.2)', paddingTop: 6, display: 'flex', flexDirection: 'column', gap: 4 },
  groupHead: {
    display: 'flex', alignItems: 'center', gap: 8, padding: '6px 4px', cursor: 'pointer',
    borderBottom: '1px solid rgba(128,128,128,0.25)', userSelect: 'none', flexWrap: 'wrap',
  },
  groupTitle: { fontWeight: 700, fontSize: 13 },
  subgroup: { display: 'flex', flexDirection: 'column', gap: 6, padding: '4px 0 8px' },
  subHead: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, opacity: 0.75, padding: '2px 2px 0' },
}

interface FormDraft {
  root: '~/.agents/skills' | '~/.dsh/skills'
  name: string
  description: string
  whenToUse: string
  modelInvocable: boolean
  userInvocable: boolean
  body: string
}

const emptyDraft = (): FormDraft => ({
  root: '~/.agents/skills', name: '', description: '', whenToUse: '',
  modelInvocable: true, userInvocable: true, body: '',
})

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, init)
  const body = (await response.json().catch(() => null)) as { ok?: boolean; error?: string; [key: string]: unknown } | null
  if (!response.ok || (body !== null && body.ok === false)) {
    const message = body !== null && typeof body.error === 'string' ? body.error : `HTTP ${response.status}`
    throw new Error(message)
  }
  return body
}

const SOURCE_LABELS: Record<string, string> = {
  'user-agents': '~/.agents/skills',
  'user-dsh': '~/.dsh/skills',
  'project-dsh': 'project .dsh',
  'project-agents': 'project .agents',
  custom: 'custom',
  runtime: 'plugin',
  bundled: 'bundled',
}

/** Canonical browse order: higher-priority (nearer) sources first. */
const SOURCE_ORDER: string[] = ['project-dsh', 'project-agents', 'custom', 'user-dsh', 'user-agents', 'runtime', 'bundled']

export function SkillSection({ t }: { t: Translate }) {
  const [list, setList] = useState<SkillListPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [sourceFilter, setSourceFilter] = useState<string>('all')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [groupBySource, setGroupBySource] = useState(true)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [expanded, setExpanded] = useState<Record<string, SkillDetailPayload | 'loading' | null>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [draft, setDraft] = useState<FormDraft | null>(null)
  const [editingName, setEditingName] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [installOpen, setInstallOpen] = useState(false)
  const [installUrl, setInstallUrl] = useState('')
  const [installPreview, setInstallPreview] = useState<{ preview: { target: Record<string, string>; sourceUrl: string; candidates: Array<{ skillPath: string; name: string; description: string; bodyPreview: string }> } } | null>(null)
  const [installSelected, setInstallSelected] = useState<string | null>(null)
  const [installRoot, setInstallRoot] = useState<'~/.agents/skills' | '~/.dsh/skills'>('~/.agents/skills')
  const [installBusy, setInstallBusy] = useState(false)
  const [installError, setInstallError] = useState<string | null>(null)
  const [installResult, setInstallResult] = useState<string | null>(null)
  const [updateStates, setUpdateStates] = useState<Record<string, { checking?: boolean; available?: boolean; busy?: boolean; error?: string }>>({})
  // --- recoverable trash ---
  const [trashOpen, setTrashOpen] = useState(false)
  const [trashItems, setTrashItems] = useState<TrashItemView[] | null>(null)
  const [trashBusy, setTrashBusy] = useState<string | null>(null)
  const [trashError, setTrashError] = useState<string | null>(null)
  const [trashNote, setTrashNote] = useState<string | null>(null)

  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setError(null)
    setLoading(true)
    try {
      const payload = await fetchJson('/dsh-tool-explorer/api/skills') as SkillListPayload
      setList(payload)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[dsh-tool-explorer] skills list load failed:', message)
      setError(message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  // Re-fetch when the page becomes visible again (e.g. after a dsh restart
  // or long idle) so the list never shows a stale catalog snapshot.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [load])

  const loadTrash = useCallback(async () => {
    setTrashError(null)
    try {
      const payload = await fetchJson('/dsh-tool-explorer/api/skills/trash') as TrashListPayload
      setTrashItems(payload.items)
    } catch (err) {
      setTrashError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => { if (trashOpen) void loadTrash() }, [trashOpen, loadTrash])

  const applyList = (payload: unknown) => {
    setList(payload as SkillListPayload)
  }

  const toggleDetail = async (name: string) => {
    const current = expanded[name]
    if (current !== undefined) {
      setExpanded(prev => {
        const next = { ...prev }
        delete next[name]
        return next
      })
      return
    }
    setExpanded(prev => ({ ...prev, [name]: 'loading' }))
    try {
      const detail = await fetchJson(`/dsh-tool-explorer/api/skills/${encodeURIComponent(name)}`) as SkillDetailPayload
      setExpanded(prev => ({ ...prev, [name]: detail }))
    } catch (err) {
      setExpanded(prev => ({ ...prev, [name]: null }))
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  /** Flip one invocation axis (model or user) for an editable skill. */
  const setAxis = async (item: SkillListItem, axis: 'model' | 'user') => {
    const next = axis === 'model' ? !item.modelInvocable : !item.userInvocable
    const key = `${item.name}:${axis}`
    setBusy(key)
    try {
      const result = await fetchJson(`/dsh-tool-explorer/api/skills/${encodeURIComponent(item.name)}/invocation`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ [axis]: next }),
      })
      applyList(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const openEdit = async (item: SkillListItem) => {
    setError(null)
    let body = ''
    try {
      setExpanded(prev => ({ ...prev, [item.name]: 'loading' }))
      const detail = await fetchJson(`/dsh-tool-explorer/api/skills/${encodeURIComponent(item.name)}`) as SkillDetailPayload
      setExpanded(prev => ({ ...prev, [item.name]: detail }))
      body = detail.raw?.body ?? detail.definition?.content ?? ''
    } catch (err) {
      setExpanded(prev => ({ ...prev, [item.name]: null }))
      setError(err instanceof Error ? err.message : String(err))
    }
    setEditingName(item.name)
    setDraft({
      root: item.source === 'user-dsh' ? '~/.dsh/skills' : '~/.agents/skills',
      name: item.name,
      description: item.description,
      whenToUse: item.whenToUse ?? '',
      modelInvocable: item.modelInvocable,
      userInvocable: item.userInvocable,
      body,
    })
    setFormError(null)
  }

  const save = async () => {
    if (draft === null) return
    setBusy('form')
    setFormError(null)
    try {
      const payload = {
        name: draft.name.trim(),
        description: draft.description.trim(),
        whenToUse: draft.whenToUse.trim() === '' ? undefined : draft.whenToUse.trim(),
        modelInvocable: draft.modelInvocable,
        userInvocable: draft.userInvocable,
        body: draft.body,
      }
      const result = editingName === null
        ? await fetchJson('/dsh-tool-explorer/api/skills', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ...payload, root: draft.root }),
          })
        : await fetchJson(`/dsh-tool-explorer/api/skills/${encodeURIComponent(editingName)}`, {
            method: 'PUT', headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          })
      applyList(result)
      setDraft(null)
      setEditingName(null)
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  /** Delete into the recoverable trash. */
  const doDelete = async (item: SkillListItem) => {
    if (!window.confirm(`${t('skillDeleteConfirm').replace('{name}', item.name)}`)) return
    setBusy(item.name)
    try {
      const result = await fetchJson(`/dsh-tool-explorer/api/skills/${encodeURIComponent(item.name)}`, { method: 'DELETE' })
      applyList(result)
      void loadTrash()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  // --- filters + grouping ---

  const filtered = (list?.skills ?? []).filter(item => {
    if (query.trim() !== '') {
      const needle = query.trim().toLowerCase()
      if (!item.name.toLowerCase().includes(needle) && !item.description.toLowerCase().includes(needle)) return false
    }
    if (sourceFilter !== 'all' && item.source !== sourceFilter) return false
    if (statusFilter === 'loaded' && item.hiddenInCatalog) return false
    if (statusFilter === 'disabled' && !item.disabled) return false
    if (statusFilter === 'hidden' && !item.hiddenInCatalog) return false
    return true
  })

  const toggleGroup = (key: string) => {
    setCollapsed(prev => ({ ...prev, [key]: !(prev[key] ?? false) }))
  }

  // --- install / update ---

  const doPreview = async () => {
    setInstallBusy(true)
    setInstallError(null)
    setInstallResult(null)
    setInstallPreview(null)
    setInstallSelected(null)
    try {
      const result = await fetchJson('/dsh-tool-explorer/api/skills/install-preview', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: installUrl.trim() }),
      })
      setInstallPreview(result as typeof installPreview)
      const candidates = (result as typeof installPreview)?.preview.candidates ?? []
      if (candidates.length === 1) setInstallSelected(candidates[0]!.name)
    } catch (err) {
      setInstallError(err instanceof Error ? err.message : String(err))
    } finally {
      setInstallBusy(false)
    }
  }

  const doInstall = async () => {
    if (installPreview === null || installSelected === null) return
    setInstallBusy(true)
    setInstallError(null)
    setInstallResult(null)
    try {
      const candidate = installPreview.preview.candidates.find(item => item.name === installSelected)
      const result = await fetchJson('/dsh-tool-explorer/api/skills/install', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          target: installPreview.preview.target,
          sourceUrl: installPreview.preview.sourceUrl,
          candidate,
          root: installRoot,
        }),
      })
      applyList(result)
      setInstallResult(t('installDone').replace('{name}', installSelected))
      setInstallPreview(null)
      setInstallSelected(null)
    } catch (err) {
      setInstallError(err instanceof Error ? err.message : String(err))
    } finally {
      setInstallBusy(false)
    }
  }

  const checkUpdate = async (item: SkillListItem) => {
    setUpdateStates(prev => ({ ...prev, [item.name]: { checking: true } }))
    try {
      const result = await fetchJson(`/dsh-tool-explorer/api/skills/${encodeURIComponent(item.name)}/check`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      }) as { updateAvailable: boolean }
      setUpdateStates(prev => ({ ...prev, [item.name]: { available: result.updateAvailable } }))
    } catch (err) {
      setUpdateStates(prev => ({ ...prev, [item.name]: { error: err instanceof Error ? err.message : String(err) } }))
    }
  }

  const doUpdate = async (item: SkillListItem) => {
    setUpdateStates(prev => ({ ...prev, [item.name]: { busy: true } }))
    try {
      const result = await fetchJson(`/dsh-tool-explorer/api/skills/${encodeURIComponent(item.name)}/update`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      })
      applyList(result)
      setUpdateStates(prev => ({ ...prev, [item.name]: { available: false } }))
    } catch (err) {
      setUpdateStates(prev => ({ ...prev, [item.name]: { error: err instanceof Error ? err.message : String(err) } }))
    }
  }

  // --- trash actions ---

  const doRestore = async (item: TrashItemView) => {
    if (item.kind === 'bundle' && list !== null && list.skills.some(skill => skill.name === item.name)) {
      setTrashError(t('trashRestoreConflict').replace('{name}', item.name))
      return
    }
    setTrashBusy(item.id)
    setTrashNote(null)
    try {
      const result = await fetchJson('/dsh-tool-explorer/api/skills/trash/restore', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: item.id }),
      })
      applyList(result)
      setTrashItems((result as { items: TrashItemView[] }).items ?? [])
      setTrashNote(t('trashRestored').replace('{name}', item.name))
    } catch (err) {
      setTrashError(err instanceof Error ? err.message : String(err))
    } finally {
      setTrashBusy(null)
    }
  }

  const doPurge = async (item: TrashItemView) => {
    if (!window.confirm(`${t('trashPurgeConfirm').replace('{name}', item.name)}`)) return
    setTrashBusy(item.id)
    setTrashNote(null)
    try {
      const result = await fetchJson('/dsh-tool-explorer/api/skills/trash/purge', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: item.id }),
      })
      setTrashItems((result as { items: TrashItemView[] }).items ?? [])
      setTrashNote(t('trashPurged').replace('{name}', item.name))
    } catch (err) {
      setTrashError(err instanceof Error ? err.message : String(err))
    } finally {
      setTrashBusy(null)
    }
  }

  const doEmptyTrash = async () => {
    if (!window.confirm(t('trashEmptyAllConfirm'))) return
    setTrashBusy('empty')
    setTrashNote(null)
    try {
      const result = await fetchJson('/dsh-tool-explorer/api/skills/trash/empty', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      }) as { purged: number }
      void loadTrash()
      void load()
      setTrashNote(`${t('trashEmptyDone')} (${result.purged})`)
    } catch (err) {
      setTrashError(err instanceof Error ? err.message : String(err))
    } finally {
      setTrashBusy(null)
    }
  }

  // --- rendering helpers ---

  const renderDetail = (name: string, item: SkillListItem) => {
    const entry = expanded[name]
    if (entry === undefined) return null
    if (entry === 'loading') return h('div', { style: styles.muted }, t('loading'))
    if (entry === null) return h('div', { style: styles.error }, t('skillDetailFail'))
    const detail = entry
    const frontmatter = detail.raw?.frontmatter
    return h('div', { style: styles.details }, [
      h('div', { style: styles.actions }, [
        h('span', { style: styles.muted }, `${t('skillProvider')}: ${item.provider}${detail.definition?.path ? ` · ${detail.definition.path}` : ''}`),
        item.lock?.sourceUrl ? h('span', { style: styles.muted }, `${t('skillSourceUrl')}: ${item.lock.sourceUrl}`) : null,
        item.lock?.installedAt ? h('span', { style: styles.muted }, `${t('skillInstalledAt')}: ${item.lock.installedAt.slice(0, 10)}`) : null,
      ]),
      frontmatter !== undefined ? h('div', { style: styles.actions }, [
        h('span', { style: styles.muted }, t('skillMeta') + ':'),
        h('span', { style: styles.muted }, String(frontmatter.name ?? '')),
      ]) : null,
      detail.raw?.body !== undefined && detail.raw.body !== ''
        ? h('pre', { style: styles.pre }, detail.raw.body.slice(0, 4000) + (detail.raw.body.length > 4000 ? '\n…' : ''))
        : h('div', { style: styles.muted }, t('skillBodyEmpty')),
    ])
  }

  const renderCard = (item: SkillListItem) => h('div', { key: item.name, style: styles.card }, [
    h('div', { style: styles.cardHead }, [
      h('span', { style: { ...styles.name, ...(item.disabled ? styles.badgeOff : {}) } }, item.name),
      h('span', { style: styles.badge }, SOURCE_LABELS[item.source] ?? item.source),
      item.disabled ? h('span', { style: styles.badge }, t('skillDisabled')) : null,
      item.hiddenInCatalog ? h('span', { style: styles.badge }, t('skillHidden')) : null,
      item.managed ? h('span', { style: styles.badge }, t('skillManaged')) : null,
      item.modelInvocable ? null : h('span', { style: styles.badge }, t('skillNoModel')),
      item.userInvocable ? null : h('span', { style: styles.badge }, t('skillNoUser')),
    ]),
    h('div', { style: styles.desc }, item.description),
    h('div', { style: styles.actions }, [
      item.editable ? h('button', { style: { ...styles.button, ...styles.buttonSmall }, onClick: () => void openEdit(item) }, t('skillEdit')) : null,
      item.editable ? h('button', {
        style: { ...styles.button, ...styles.buttonSmall, ...(item.modelInvocable ? {} : styles.buttonDanger) },
        onClick: () => void setAxis(item, 'model'),
        disabled: busy === `${item.name}:model`,
      }, `${t('skillModelAxis')}: ${item.modelInvocable ? t('skillOn') : t('skillOff')}`) : null,
      item.editable ? h('button', {
        style: { ...styles.button, ...styles.buttonSmall, ...(item.userInvocable ? {} : styles.buttonDanger) },
        onClick: () => void setAxis(item, 'user'),
        disabled: busy === `${item.name}:user`,
      }, `${t('skillUserAxis')}: ${item.userInvocable ? t('skillOn') : t('skillOff')}`) : null,
      item.managed ? h('button', {
        style: { ...styles.button, ...styles.buttonSmall },
        onClick: () => void checkUpdate(item),
        disabled: updateStates[item.name]?.checking === true || updateStates[item.name]?.busy === true,
      }, updateStates[item.name]?.checking ? t('skillChecking') : t('skillCheck')) : null,
      updateStates[item.name]?.available === true ? h('button', { style: { ...styles.button, ...styles.buttonPrimary, ...styles.buttonSmall }, onClick: () => void doUpdate(item), disabled: updateStates[item.name]?.busy === true }, t('skillUpdateBtn')) : null,
      updateStates[item.name]?.error !== undefined ? h('span', { style: { ...styles.muted, color: '#e06666' } }, updateStates[item.name].error) : null,
      item.editable ? h('button', {
        style: { ...styles.button, ...styles.buttonSmall, ...styles.buttonDanger },
        onClick: () => void doDelete(item),
        disabled: busy === item.name,
      }, t('skillDelete')) : null,
      h('button', { style: { ...styles.button, ...styles.buttonSmall }, onClick: () => void toggleDetail(item.name) }, t('skillDetail')),
    ]),
    renderDetail(item.name, item),
  ])

  /** Hierarchical view: source → provider → skills. */
  const grouped = () => {
    const groups: Array<{ source: string; providers: Array<{ provider: string; skills: SkillListItem[] }> }> = []
    for (const item of filtered) {
      let group = groups.find(g => g.source === item.source)
      if (group === undefined) {
        group = { source: item.source, providers: [] }
        groups.push(group)
      }
      let sub = group.providers.find(p => p.provider === item.provider)
      if (sub === undefined) {
        sub = { provider: item.provider, skills: [] }
        group.providers.push(sub)
      }
      sub.skills.push(item)
    }
    groups.sort((a, b) => {
      const ia = SOURCE_ORDER.indexOf(a.source)
      const ib = SOURCE_ORDER.indexOf(b.source)
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)
    })
    for (const group of groups) group.providers.sort((a, b) => a.provider.localeCompare(b.provider))
    return groups
  }

  const loadedCount = (list?.skills ?? []).filter(item => !item.hiddenInCatalog).length
  const trashCount = list?.trashCount ?? 0

  const renderTrashPanel = () => h('div', { style: styles.panel }, [
    h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, justifyContent: 'space-between', flexWrap: 'wrap' } }, [
      h('span', { style: styles.panelTitle }, `${t('skillTrash')} (${trashItems?.length ?? 0})`),
      h('div', { style: styles.actions }, [
        h('button', { style: { ...styles.button, ...styles.buttonSmall, ...styles.buttonDanger }, onClick: () => void doEmptyTrash(), disabled: trashBusy === 'empty' || (trashItems?.length ?? 0) === 0 }, t('trashEmptyAll')),
        h('button', { style: { ...styles.button, ...styles.buttonSmall }, onClick: () => setTrashOpen(false) }, t('cancel')),
      ]),
    ]),
    trashNote === null ? null : h('div', { style: styles.ok }, trashNote),
    trashError === null ? null : h('div', { style: styles.error }, trashError),
    trashItems === null
      ? h('div', { style: styles.muted }, t('loading'))
      : trashItems.length === 0
        ? h('div', { style: styles.empty }, t('trashNoItems'))
        : trashItems.map(item => h('div', { key: item.id, style: { ...styles.card, padding: '6px 10px' } }, [
            h('div', { style: styles.cardHead }, [
              h('span', { style: styles.name }, item.name),
              h('span', { style: styles.badge }, item.rootLabel),
              h('span', { style: styles.badge }, t(item.kind === 'bundle' ? 'trashKindBundle' : 'trashKindFile')),
              item.managed ? h('span', { style: styles.badge }, t('trashManagedBadge')) : null,
              item.exists ? null : h('span', { style: { ...styles.badge, ...styles.buttonDanger } }, t('trashMissing')),
            ]),
            h('div', { style: styles.actions }, [
              h('span', { style: styles.muted }, `${t('trashDeletedAt')}: ${item.deletedAt.slice(0, 19).replace('T', ' ')}`),
              h('button', { style: { ...styles.button, ...styles.buttonSmall, ...styles.buttonPrimary }, onClick: () => void doRestore(item), disabled: trashBusy === item.id || !item.exists }, t('trashRestore')),
              h('button', { style: { ...styles.button, ...styles.buttonSmall, ...styles.buttonDanger }, onClick: () => void doPurge(item), disabled: trashBusy === item.id }, t('trashPurge')),
            ]),
          ])),
  ])

  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } }, [
    h('div', { style: styles.toolbar }, [
      h('button', { style: { ...styles.button, ...styles.buttonPrimary }, onClick: () => { setEditingName(null); setDraft(emptyDraft()); setFormError(null) } }, t('skillNew')),
      h('button', { style: styles.button, onClick: () => { setInstallOpen(true); setInstallError(null); setInstallResult(null); setInstallPreview(null); setInstallSelected(null) } }, t('skillInstallGit')),
      h('button', { style: { ...styles.button, ...(trashCount > 0 ? styles.buttonDanger : {}) }, onClick: () => { setTrashNote(null); setTrashOpen(!trashOpen) } }, `${t('skillTrash')} (${trashCount})`),
      h('input', { style: styles.search, value: query, placeholder: t('skillSearch'), onChange: (event: React.ChangeEvent<HTMLInputElement>) => setQuery(event.target.value) }),
      h('select', { style: styles.input, value: sourceFilter, onChange: (event: React.ChangeEvent<HTMLSelectElement>) => setSourceFilter(event.target.value) }, [
        h('option', { value: 'all' }, t('srcAllAll')),
        ...SOURCE_ORDER.map(source => h('option', { key: source, value: source }, SOURCE_LABELS[source] ?? source)),
      ]),
      h('select', { style: styles.input, value: statusFilter, onChange: (event: React.ChangeEvent<HTMLSelectElement>) => setStatusFilter(event.target.value) }, [
        h('option', { value: 'all' }, t('statusAll')),
        h('option', { value: 'loaded' }, t('statusLoaded')),
        h('option', { value: 'disabled' }, t('statusDisabled')),
        h('option', { value: 'hidden' }, t('statusHidden')),
      ]),
      h('label', { style: { ...styles.checkRow, opacity: 0.9 } }, [
        h('input', { type: 'checkbox', checked: groupBySource, onChange: (event: React.ChangeEvent<HTMLInputElement>) => setGroupBySource(event.target.checked) }),
        t('groupBySource'),
      ]),
      h('button', { style: styles.button, onClick: () => void load() }, t('refresh')),
      h('span', { style: styles.muted }, `${filtered.length}/${list?.skills.length ?? 0} · ${t('skillCountNote')} · ${t('statusLoaded')} ${loadedCount}`),
    ]),
    error === null ? null : h('div', { style: styles.error }, error),
    list !== null && list.viewScope === 'host'
      ? h('div', { style: styles.muted }, t('skillHostViewOnly'))
      : null,

    trashOpen ? renderTrashPanel() : null,

    installOpen ? h('div', { style: styles.panel }, [
      h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8 } }, [
        h('span', { style: styles.panelTitle }, t('skillInstallGit')),
        h('button', { style: { ...styles.button, ...styles.buttonSmall }, onClick: () => setInstallOpen(false) }, t('cancel')),
      ]),
      h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } }, [
        h('input', { style: { ...styles.search, flex: '1 1 280px' }, value: installUrl, placeholder: 'owner/repo 或 https://github.com/owner/repo[/tree/branch/path]', onChange: (event: React.ChangeEvent<HTMLInputElement>) => setInstallUrl(event.target.value) }),
        h('button', { style: styles.button, onClick: () => void doPreview(), disabled: installBusy || installUrl.trim() === '' }, t('skillInstallPreview')),
        h('select', { style: styles.input, value: installRoot, onChange: (event: React.ChangeEvent<HTMLSelectElement>) => setInstallRoot(event.target.value as '~/.agents/skills' | '~/.dsh/skills') }, [
          h('option', { value: '~/.agents/skills' }, '~/.agents/skills'),
          h('option', { value: '~/.dsh/skills' }, '~/.dsh/skills'),
        ]),
      ]),
      installError === null ? null : h('div', { style: styles.error }, installError),
      installResult === null ? null : h('div', { style: styles.ok }, installResult),
      installPreview !== null
        ? (installPreview.preview.candidates.length === 0
          ? h('div', { style: styles.muted }, t('installNoCandidate'))
          : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } }, [
              installPreview.preview.candidates.map(candidate => h('label', { key: candidate.name, style: { ...styles.checkRow } }, [
                h('input', { type: 'radio', name: 'install-candidate', checked: installSelected === candidate.name, onChange: () => setInstallSelected(candidate.name) }),
                h('span', { style: { fontWeight: 600 } }, candidate.name),
                h('span', { style: styles.muted }, `[${candidate.skillPath || 'repo root'}]`),
                h('span', { style: styles.muted }, candidate.description),
              ])),
              h('div', { style: styles.actions }, [
                h('button', { style: { ...styles.button, ...styles.buttonPrimary }, onClick: () => void doInstall(), disabled: installBusy || installSelected === null }, t('skillInstallRun')),
              ]),
            ]))
        : null,
    ]) : null,

    draft === null ? null : h('div', { style: styles.panel }, [
      h('div', { style: styles.panelTitle }, t(editingName === null ? 'skillNew' : 'skillEdit')),
      h('div', { style: { display: 'flex', gap: 12, flexWrap: 'wrap' } }, [
        h('div', { style: { ...styles.fieldRow, flex: '1 1 200px' } }, [
          h('label', { style: styles.label }, t('skillFieldName')),
          h('input', { style: styles.input, value: draft.name, placeholder: 'my-skill', onChange: (event: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, name: event.target.value }) }),
        ]),
        editingName !== null ? null : h('div', { style: { ...styles.fieldRow, flex: '0 0 180px' } }, [
          h('label', { style: styles.label }, t('skillFieldRoot')),
          h('select', { style: styles.input, value: draft.root, onChange: (event: React.ChangeEvent<HTMLSelectElement>) => setDraft({ ...draft, root: event.target.value as '~/.agents/skills' | '~/.dsh/skills' }) }, [
            h('option', { value: '~/.agents/skills' }, '~/.agents/skills'),
            h('option', { value: '~/.dsh/skills' }, '~/.dsh/skills'),
          ]),
        ]),
      ]),
      h('div', { style: styles.fieldRow }, [
        h('label', { style: styles.label }, t('skillFieldDescription')),
        h('input', { style: styles.input, value: draft.description, placeholder: t('skillFieldDescriptionPh'), onChange: (event: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, description: event.target.value }) }),
      ]),
      h('div', { style: styles.fieldRow }, [
        h('label', { style: styles.label }, t('skillFieldWhenToUse')),
        h('input', { style: styles.input, value: draft.whenToUse, onChange: (event: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, whenToUse: event.target.value }) }),
      ]),
      h('div', { style: { display: 'flex', gap: 16, flexWrap: 'wrap' } }, [
        h('label', { style: { ...styles.label, display: 'flex', gap: 6, alignItems: 'center' } }, [
          h('input', { type: 'checkbox', checked: draft.modelInvocable, onChange: (event: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, modelInvocable: event.target.checked }) }),
          t('skillFieldModel'),
        ]),
        h('label', { style: { ...styles.label, display: 'flex', gap: 6, alignItems: 'center' } }, [
          h('input', { type: 'checkbox', checked: draft.userInvocable, onChange: (event: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, userInvocable: event.target.checked }) }),
          t('skillFieldUser'),
        ]),
      ]),
      h('div', { style: styles.fieldRow }, [
        h('label', { style: styles.label }, t('skillFieldBody')),
        h('textarea', { style: { ...styles.input, ...styles.textarea }, value: draft.body, placeholder: '# My Skill\n\n...', onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => setDraft({ ...draft, body: event.target.value }) }),
      ]),
      formError === null ? null : h('div', { style: styles.error }, formError),
      h('div', { style: styles.actions }, [
        h('button', { style: styles.button, onClick: () => { setDraft(null); setEditingName(null); setFormError(null) } }, t('cancel')),
        h('button', { style: { ...styles.button, ...styles.buttonPrimary }, onClick: () => void save(), disabled: busy === 'form' }, t('save')),
      ]),
    ]),

    list === null
      ? h('div', { style: styles.empty }, t('loading'))
      : filtered.length === 0
        ? h('div', { style: styles.empty }, t('skillEmpty'))
        : groupBySource
          ? grouped().map(group => {
              const key = group.source
              const isCollapsed = collapsed[key] ?? false
              const groupSkills = group.providers.flatMap(sub => sub.skills)
              return h('div', { key, style: { display: 'flex', flexDirection: 'column', gap: 4 } }, [
                h('div', { style: styles.groupHead, onClick: () => toggleGroup(key) }, [
                  h('span', { style: { fontSize: 11, opacity: 0.8 } }, isCollapsed ? '▸' : '▾'),
                  h('span', { style: styles.groupTitle }, SOURCE_LABELS[group.source] ?? group.source),
                  h('span', { style: styles.muted }, `${groupSkills.length} · ${t('statusLoaded')} ${groupSkills.filter(skill => !skill.hiddenInCatalog).length} · ${t('skillDisabled')} ${groupSkills.filter(skill => skill.disabled).length}`),
                ]),
                isCollapsed ? null : group.providers.map(sub => h('div', { key: `${group.source}/${sub.provider}`, style: styles.subgroup }, [
                  h('div', { style: styles.subHead }, [
                    h('span', { style: { fontWeight: 600 } }, sub.provider),
                    h('span', { style: styles.muted }, `(${sub.skills.length})`),
                  ]),
                  h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } }, sub.skills.map(renderCard)),
                ])),
              ])
            })
          : filtered.map(renderCard),
  ])
}
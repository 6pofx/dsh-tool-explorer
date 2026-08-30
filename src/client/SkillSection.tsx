/**
 * The Skills tab: catalog of every discovered skill (registry × lock file ×
 * user-root disk scan), search/filter, detail preview, inline edit/create,
 * and the enable/disable toggle (frontmatter dual switches).
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

const styles: Record<string, React.CSSProperties> = {
  toolbar: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 4, flexWrap: 'wrap' },
  search: {
    padding: '4px 8px', fontSize: 12, border: '1px solid rgba(128,128,128,0.4)', borderRadius: 4,
    background: 'transparent', color: 'inherit', fontFamily: 'inherit', minWidth: 200,
  },
  button: {
    padding: '5px 12px', fontSize: 12, border: '1px solid rgba(128,128,128,0.4)',
    borderRadius: 4, background: 'transparent', color: 'inherit', cursor: 'pointer',
  },
  buttonPrimary: { background: 'rgba(100,140,255,0.18)', borderColor: 'rgba(100,140,255,0.6)' },
  buttonSmall: { padding: '2px 8px', fontSize: 11 },
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

export function SkillSection({ t }: { t: Translate }) {
  const [list, setList] = useState<SkillListPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Record<string, SkillDetailPayload | 'loading' | null>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [draft, setDraft] = useState<FormDraft | null>(null)
  const [editingName, setEditingName] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      setList(await fetchJson('/dsh-tool-explorer/api/skills') as SkillListPayload)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => { void load() }, [load])

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

  const toggleEnabled = async (item: SkillListItem) => {
    setBusy(item.name)
    try {
      const result = await fetchJson(`/dsh-tool-explorer/api/skills/${encodeURIComponent(item.name)}/toggle`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: item.disabled }),
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

  const filtered = (list?.skills ?? []).filter(item => {
    if (query.trim() === '') return true
    const needle = query.trim().toLowerCase()
    return item.name.toLowerCase().includes(needle) || item.description.toLowerCase().includes(needle)
  })

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

  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } }, [
    h('div', { style: styles.toolbar }, [
      h('button', { style: { ...styles.button, ...styles.buttonPrimary }, onClick: () => { setEditingName(null); setDraft(emptyDraft()); setFormError(null) } }, t('skillNew')),
      h('input', { style: styles.search, value: query, placeholder: t('skillSearch'), onChange: (event: React.ChangeEvent<HTMLInputElement>) => setQuery(event.target.value) }),
      h('button', { style: styles.button, onClick: () => void load() }, t('refresh')),
      h('span', { style: styles.muted }, `${filtered.length}/${list?.skills.length ?? 0} · ${t('skillCountNote')}`),
    ]),
    error === null ? null : h('div', { style: styles.error }, error),

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
        : filtered.map(item => h('div', { key: item.name, style: styles.card }, [
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
              style: { ...styles.button, ...styles.buttonSmall },
              onClick: () => void toggleEnabled(item),
              disabled: busy === item.name,
            }, item.disabled ? t('skillEnable') : t('skillDisable')) : null,
            h('button', { style: { ...styles.button, ...styles.buttonSmall }, onClick: () => void toggleDetail(item.name) }, t('skillDetail')),
          ]),
          renderDetail(item.name, item),
        ])),
  ])
}

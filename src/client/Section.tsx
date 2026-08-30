/**
 * The Tool Explorer settings section page (milestone M0 skeleton).
 * Two tabs — Skills / MCP — with placeholder panels and a live host-status
 * probe proving the /dsh-tool-explorer/api/status route wiring.
 */

import { createElement as h, useEffect, useState } from 'react'
import { McpSection } from './McpSection'
import { SkillSection } from './SkillSection'

export type Translate = (key: string) => string

export interface SectionProps {
  t: Translate
  preferredSubsectionId?: string
}

interface StatusPayload {
  ok: boolean
  name: string
  version: string
  profile: string
  loaderEntries: number
  selfEntry: boolean
  features: { skills: boolean; mcp: boolean }
  config: { defaultSkillRoot: string; mcpConfigTarget: string; previewContentLimit: number }
}

const styles: Record<string, React.CSSProperties> = {
  wrap: { display: 'flex', flexDirection: 'column', gap: 12 },
  header: { display: 'flex', alignItems: 'baseline', gap: 8 },
  title: { margin: 0, fontSize: 18, fontWeight: 600 },
  version: { fontSize: 12, opacity: 0.6 },
  tabs: { display: 'flex', gap: 4, borderBottom: '1px solid rgba(128,128,128,0.3)' },
  tab: {
    padding: '6px 14px',
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    fontSize: 13,
    borderBottom: '2px solid transparent',
    color: 'inherit',
  },
  tabActive: { borderBottomColor: 'currentColor', fontWeight: 600 },
  panel: { padding: '8px 0', fontSize: 13, display: 'flex', flexDirection: 'column', gap: 8 },
  stateRow: { display: 'flex', gap: 12, alignItems: 'center', fontSize: 12, opacity: 0.85 },
  note: { opacity: 0.6 },
  refresh: {
    alignSelf: 'flex-start',
    padding: '4px 10px',
    fontSize: 12,
    border: '1px solid rgba(128,128,128,0.4)',
    borderRadius: 4,
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
  },
}

function StatusRow({ t, status }: { t: Translate; status: StatusPayload | null | undefined }) {
  if (status === undefined) {
    return h('div', { style: styles.stateRow }, t('loading'))
  }
  if (status === null) {
    return h('div', { style: styles.stateRow }, t('hostFail'))
  }
  return h('div', { style: styles.stateRow }, [
    h('span', null, status.ok ? t('hostOk') : t('hostFail')),
    h('span', null, `${t('version')}: ${status.version}`),
    h('span', null, `${t('profile')}: ${status.profile}`),
    h('span', null, `${t('loaderEntries')}: ${status.loaderEntries}`),
    h('span', null, `${t('selfEntry')}: ${status.selfEntry ? t('selfEntryYes') : t('selfEntryNo')}`),
  ])
}

function PlaceholderPanel({ t, label }: { t: Translate; label: string }) {
  return h('div', { style: styles.panel }, [
    h('div', null, label),
    h('div', { style: styles.note }, t('featureNote')),
  ])
}

export function Section({ t, preferredSubsectionId }: SectionProps) {
  const [tab, setTab] = useState<'skills' | 'mcp'>(preferredSubsectionId === 'mcp' ? 'mcp' : 'skills')
  const [status, setStatus] = useState<StatusPayload | null | undefined>(undefined)

  const load = () => {
    setStatus(undefined)
    void fetch('/dsh-tool-explorer/api/status')
      .then(response => response.json() as Promise<StatusPayload>)
      .then(setStatus)
      .catch(() => setStatus(null))
  }

  useEffect(load, [])

  return h('div', { style: styles.wrap }, [
    h('div', { style: styles.header }, [
      h('h2', { style: styles.title }, t('nav')),
      h('span', { style: styles.version }, status?.version ?? ''),
    ]),
    h('div', { style: styles.tabs }, [
      h('button', {
        style: { ...styles.tab, ...(tab === 'skills' ? styles.tabActive : {}) },
        onClick: () => setTab('skills'),
      }, t('skillsTab')),
      h('button', {
        style: { ...styles.tab, ...(tab === 'mcp' ? styles.tabActive : {}) },
        onClick: () => setTab('mcp'),
      }, t('mcpTab')),
    ]),
    h('div', { style: styles.panel }, [
      h('div', { style: styles.stateRow }, [
        h(StatusRow, { t, status }),
        h('button', { style: styles.refresh, onClick: load }, t('refresh')),
      ]),
      tab === 'skills'
        ? h(SkillSection, { t })
        : h(McpSection, { t }),
    ]),
  ])
}

/**
 * dsh-tool-explorer client: registers a "Tool Explorer" settings section
 * rendering the management console. Built by tsdown into the
 * __ModuleLoader__ factory bundle at client/client.js; the only externals
 * are the loader module table's react entries.
 */

import { createElement as h } from 'react'
import { en, zh } from './locales'
import { Section, type Translate } from './Section'

const NS = 'dsh-tool-explorer'

/** The subset of the locale service this plugin touches. */
interface LocaleService {
  register(namespace: string, dicts: { zh: Record<string, string>; en: Record<string, string> }): unknown
  bind(namespace: string): Translate
}

/** The subset of the slots service this plugin touches. */
interface SlotsService {
  inject(slot: string, register: () => unknown): void
  register(meta: Record<string, unknown>, component: () => unknown): unknown
}

/** The client cordis context shape this plugin relies on (structural: the
 * host provides the real Context; typing only the touched surface keeps this
 * package free of monorepo-internal type dependencies). */
interface ToolExplorerClientContext {
  effect(callback: () => unknown, label?: string): void
  locale: LocaleService
  slots: SlotsService
}

export const name = 'dsh-tool-explorer'
export const inject = ['slots', 'locale']

export function apply(ctx: ToolExplorerClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-tool-explorer: dictionaries')
  const t = ctx.locale.bind(NS)

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'tool-explorer',
    order: 50,
    label: () => t('nav'),
    locale: NS,
    inject: () => ({ t }),
  }, (ownerProps: { preferredSubsectionId?: string } = {}) => h(Section, {
    t,
    preferredSubsectionId: ownerProps.preferredSubsectionId,
  })))
}

/**
 * The profile patch-layer dialect (cordis.patch.yml): a top-level YAML array
 * of loader rows. This module owns parsing (same js-yaml dialect the Loader
 * uses, including `!!js` scalars) and surgical TEXT writes — appending and
 * removing rows without touching comments or hand-written structure.
 *
 * Row semantics (mirrors @deepseek-ai/dsh-app-boot's applyEntryPatches):
 * - `- insert: [...]` adds loader entries;
 * - `- id: X` + `config: {...}` REPLACES entry X's config wholesale
 *   (later rows win; a row targeting a missing entry is skipped);
 * - `- id: X` + `disabled: true|false` toggles an entry.
 *
 * Safety:
 * - an append is refused when the file is not a valid entry list (a
 *   malformed layer must never be made worse);
 * - removing the last row restores the `[]` placeholder, because dsh
 *   refuses to boot a profile whose patch file is not a top-level array;
 * - every write is atomic (temp file + rename) so the HMR watcher sees one
 *   complete change event.
 */

import { dump, JSON_SCHEMA, load, Type, type Schema } from 'js-yaml'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** The `!!js` expression node shape the Loader produces. */
export interface JsExprNode {
  __jsExpr: string
}

export function isJsExpr(value: unknown): value is JsExprNode {
  return typeof value === 'object' && value !== null
    && (value as Record<string, unknown>).__jsExpr !== undefined
}

/** js-yaml Type for `!!js` scalars — identical to dsh-app-boot's dialect. */
const jsExprType = new Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data: unknown): boolean => typeof data === 'string',
  construct: (data: unknown): JsExprNode => ({ __jsExpr: String(data) }),
})

/** The entry-list YAML schema: JSON_SCHEMA extended with `!!js` scalars. */
export const entrySchema: Schema = JSON_SCHEMA.extend(jsExprType)

/** Parse one patch file into rows; null when it is not a valid entry list. */
export function parsePatchText(text: string): unknown[] | null {
  try {
    const value = load(text, { schema: entrySchema })
    return Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

/** One parsed top-level patch row. */
export interface PatchRow {
  id?: string
  name?: string
  insert?: PatchEntry[]
  config?: unknown
  disabled?: unknown
  [key: string]: unknown
}

/** One inserted loader entry. */
export interface PatchEntry {
  id?: string
  name?: string
  config?: unknown
  disabled?: unknown
  [key: string]: unknown
}

/** Strip the template's empty `[]` placeholder (comment it out) before appending rows. */
function commentPlaceholder(text: string): string {
  return text.replace(/^[ \t]*\[[ \t]*\][ \t]*(?:#.*)?(?:\r?\n|$)/mu, '# []\n')
}

/** Restore `[]` when nothing but comments remains — dsh requires a top-level array. */
function restorePlaceholder(text: string): string {
  if (text.replace(/^[ \t]*#.*$/gmu, '').trim() !== '') return text
  const revived = text.replace(/^[ \t]*#[ \t]*\[[ \t]*\][ \t]*(?:#.*)?(?:\r?\n|$)/mu, '[]\n')
  if (revived !== text) return revived
  return text === '' || text.endsWith('\n') ? `${text}[]\n` : `${text}\n[]\n`
}

/** True when a raw text block is a top-level `- insert:` row whose payload contains the id. */
function blockInsertsId(block: string, id: string): boolean {
  const lines = block.split(/\r?\n/u)
  const first = lines[0] ?? ''
  if (!/^- insert:\s*(?:#.*)?$/u.test(first) && !/^[ \t]+insert:\s*(?:#.*)?$/u.test(first)) return false
  const idRe = new RegExp(`^[ \\t]{4,}- id: ['\"]?${escapeRegExp(id)}['\"]?\\s*(?:#.*)?$`, 'mu')
  return lines.some(line => line !== first && idRe.test(line))
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/** True when a raw text block is a top-level `- id: X` row (override/disable). */
function blockTargetsId(block: string, id: string): boolean {
  const first = (block.split(/\r?\n/u)[0] ?? '').trimEnd()
  return new RegExp(`^- id: ['\"]?${escapeRegExp(id)}['\"]?\\s*(?:#.*)?$`, 'u').test(first)
}

/**
 * Remove only `- id: X` + `disabled: true|false` blocks for an id, keeping
 * its insert/override rows intact (the enable/disable toggle path).
 */
export function removeDisabledRowsForId(text: string, id: string): string {
  const trimmed = text.trimEnd()
  const kept = rowBlocks(trimmed).filter(block => {
    const lines = block.split(/\r?\n/u)
    const first = (lines[0] ?? '').trimEnd()
    if (!new RegExp(`^- id: ['\"]?${escapeRegExp(id)}['\"]?\\s*(?:#.*)?$`, 'u').test(first)) return true
    return !/^\s+disabled:\s*(?:true|false)\s*(?:#.*)?$/u.test(lines[1] ?? '')
  })
  const next = kept.length > 0 ? kept.join('\n') : '[]'
  const withPlaceholder = restorePlaceholder(next)
  return withPlaceholder === text ? text : withPlaceholder
}

/** Split patch text into top-level row blocks (each starting with `- ` at column 0). */
function rowBlocks(text: string): string[] {
  const lines = text.split(/\r?\n/u)
  const blocks: string[] = []
  let current: string[] = []
  for (const line of lines) {
    if (/^- /u.test(line) && current.length > 0) {
      blocks.push(current.join('\n'))
      current = []
    }
    current.push(line)
  }
  if (current.length > 0) blocks.push(current.join('\n'))
  return blocks
}

/**
 * Remove every top-level row that targets `id` (insert rows whose payload
 * carries it, override and disable rows). Returns the new text; when nothing
 * matched the text is returned unchanged.
 */
export function removeRowsForId(text: string, id: string): string {
  const trimmed = text.trimEnd()
  const kept = rowBlocks(trimmed).filter(block => {
    if (blockInsertsId(block, id)) return false
    if (blockTargetsId(block, id)) return false
    return true
  })
  const next = kept.length > 0 ? kept.join('\n') : '[]'
  const withPlaceholder = restorePlaceholder(next)
  return withPlaceholder === text ? text : withPlaceholder
}

/** YAML scalar for ids: bare when the id is safe, quoted otherwise. */
function scalar(value: string): string {
  return /^[A-Za-z0-9_.-]+$/u.test(value) ? value : JSON.stringify(value)
}

/** Render one `- insert:` row block for an MCP server entry. */
export function insertRowBlock(id: string, name: string, config: Record<string, unknown>): string {
  const payload = dump([{ id, name, config }], { indent: 2, lineWidth: -1, noRefs: true }).trimEnd()
  return `- insert:\n${indent(payload, '    ')}\n`
}

/** Render one id-targeted row block carrying a replacement config. */
export function overrideRowBlock(id: string, config: Record<string, unknown>): string {
  return `- id: ${scalar(id)}\n${indent(dump({ config }, { indent: 2, lineWidth: -1, noRefs: true }).trimEnd(), '  ')}\n`
}

/** Render one disabled/force-enabled row block. */
export function toggleRowBlock(id: string, disabled: boolean): string {
  return `- id: ${scalar(id)}\n  disabled: ${disabled ? 'true' : 'false'}\n`
}

/** Prefix every line of a string. */
function indent(text: string, prefix: string): string {
  return text.replace(/^/gmu, prefix).replace(/^[ \t]*$/gmu, '')
}

/**
 * Append one top-level row block, refusing when the existing file is not a
 * valid entry list.
 * @returns the new text on success, or a reason when the append was refused.
 */
export function appendRowBlock(text: string, block: string): { ok: true; text: string } | { ok: false; reason: string } {
  if (text.replace(/^[ \t]*#.*$/gmu, '').trim() === '') {
    return { ok: true, text: `${text.endsWith('\n') ? text : `${text}\n`}${block}` }
  }
  const withoutComments = text.replace(/^[ \t]*#.*$/gmu, '').trim()
  if (withoutComments === '[]' || withoutComments === '[ ]') {
    const commented = commentPlaceholder(text)
    return { ok: true, text: `${commented.endsWith('\n') ? commented : `${commented}\n`}${block}` }
  }
  if (withoutComments !== '' && parsePatchText(text) === null) {
    return { ok: false, reason: 'the patch layer is not a valid entry list; the write was refused to avoid deepening the break' }
  }
  return { ok: true, text: `${text.endsWith('\n') ? text : `${text}\n`}${block}` }
}

/** Atomic file write: temp file + rename so watchers see one change event. */
export function atomicWrite(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, text, 'utf8')
  try {
    renameSync(tmp, path)
  } catch (error) {
    try {
      // Windows rename-over-existing can race with the HMR reader; retry once.
      renameSync(tmp, path)
    } catch {
      throw error
    }
  }
}

/** Read a patch file; `null` when it does not exist. */
export function readPatchOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** The directory of a file path (used for atomic writes), as a string. */
export function directoryOf(path: string): string {
  return dirname(path)
}

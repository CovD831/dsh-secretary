/** 可信记忆单写者服务：串行 GitRepoLock、秘密拒写门、CAS 乐观锁、常驻预算闸与审计事件发射。 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { isoTime } from '../core/model.ts'
import { GitRepoLock } from '../spine/git-sink.ts'
import { redactDraft, redactValue } from '../spine/redact.ts'
import type { SourceRef, SpineDraft, Taint as SpineTaint } from '../spine/types.ts'
import { assertSafeMemoryPath, formatChangeLogLine, listMemoryPages, readMemoryPage, resolveMemoryRelPath, writeMemoryPage } from './codec.ts'
import { assertResidentBudget, DEFAULT_MEMORY_BUDGETS, isEntryActiveAt } from './recall.ts'
import {
  ResidentBudgetExceededError, type AttentionItem, type AttentionProposal, type AttentionTransition,
  type FactLayer, type FactPage, type LedgerPage, type MemoryEntry, type MemoryProposal, type MemoryScope,
  type TombstoneInput, type TombstoneResult, type WriteRejectReason, type WriteResult,
} from './types.ts'

const execFileAsync = promisify(execFile)
const ISOLATED_ENV_KEYS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
  'GIT_AUTHOR_NAME', 'GIT_COMMITTER_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_EMAIL'] as const
const normText = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ')
const validRef = (ref?: SourceRef): ref is SourceRef => Boolean(ref && Number.isSafeInteger(ref.seq) && ref.seq > 0 && typeof ref.id === 'string' && ref.id.trim())
const hasSecret = (vals: readonly (string | undefined)[]): boolean => vals.some(v => v !== undefined && redactValue(v).redacted.length > 0)
const reject = (reason: WriteRejectReason, detail: string, extra?: { attentionItem?: AttentionItem; commit?: string }): WriteResult =>
  ({ kind: 'rejected', reason, detail, ...extra })

function isolatedGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', GIT_CONFIG_NOSYSTEM: '1' }
  for (const key of ISOLATED_ENV_KEYS) delete env[key]
  env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null'
  return env
}

function validateProposal(p: MemoryProposal): { error: WriteResult } | { targetRel: string } {
  if ('id' in p && (p as { id?: unknown }).id !== undefined) return { error: reject('caller-id-forbidden', '记忆 id 必须由宿主分配') }
  if ('changeLog' in p && (p as { changeLog?: unknown }).changeLog !== undefined) return { error: reject('invalid-input', '禁止篡改 Change Log') }
  if (hasSecret([p.statement, p.verbatimQuote, p.evidenceText, p.invalidationReason, p.topicKey, p.scope, p.author, p.sourceRef?.id,
    ...(p.workspacesSeen ?? []), ...(p.triggerKeys?.primary ?? []), ...(p.triggerKeys?.secondary ?? [])])) {
    return { error: reject('secret-detected', '检测到秘密或凭据形状，已触发拒写门') }
  }
  if (!validRef(p.sourceRef)) return { error: reject('missing-source-ref', '缺少有效的 M0 sourceRef (seq > 0 且 id 非空)') }
  if (!p.statement.trim() || !p.author.trim()) return { error: reject('invalid-input', 'statement 与 author 不能为空') }
  if (p.expectedRevision !== undefined && (!Number.isSafeInteger(p.expectedRevision) || p.expectedRevision < 0)) return { error: reject('invalid-input', 'expectedRevision 必须为非负整数') }
  if (p.importance !== undefined && (!Number.isFinite(p.importance) || p.importance < 0 || p.importance > 10)) return { error: reject('invalid-input', 'importance 须在 0–10 间') }
  if ([p.observedAt, p.validFrom, p.lastAccessedAt].some(ts => ts !== undefined && !Number.isFinite(Date.parse(ts)))) return { error: reject('invalid-input', '时间戳格式非法') }
  const validScope = p.scope === 'global' || /^workspace:[^\s]+$/.test(p.scope) || /^person:[^\s]+$/.test(p.scope)
  if (!validScope || (p.layer === 'm4' && p.scope !== 'global') || (p.layer === 'm2' && p.scope.startsWith('workspace:'))) return { error: reject('scope-mismatch', `层级 ${p.layer} 不允许作用域 "${p.scope}"`) }
  if (p.layer === 'm2' && (p.taint === 'external_untrusted' || p.sourceType === 'external_doc')) return { error: reject('untrusted-m2-forbidden', '禁止不可信外部来源 (external_untrusted/external_doc) 写入 M2 偏好层') }
  if (p.layer === 'm3' && (!p.scope.startsWith('workspace:') || (p.workspaceKey && p.workspaceKey !== p.scope.slice(10)))) return { error: reject('scope-mismatch', `M3 作用域与 workspaceKey 不匹配: "${p.scope}"`) }
  if (p.layer === 'm4') {
    const uniq = new Set((p.workspacesSeen ?? []).map(s => s.trim()).filter(Boolean))
    if ((uniq.size < 2 || (p.seenCount ?? 0) < 2) && p.sourceType !== 'user_ruling') {
      return { error: reject('m4-threshold-not-met', '写 M4 须满足 workspacesSeen 去重 >= 2 且 seenCount >= 2，或显式 user_ruling') }
    }
  }
  try { return { targetRel: resolveMemoryRelPath({ layer: p.layer, slug: p.slug, workspaceKey: p.layer === 'm3' ? (p.workspaceKey ?? p.scope.slice(10)) : undefined }) } }
  catch (err) { return { error: reject('invalid-input', err instanceof Error ? err.message : String(err)) } }
}

function buildEntry(p: MemoryProposal, id: string, nowIso: string, isInf: boolean, isUserAuth: boolean, supersedes?: string): MemoryEntry {
  return {
    id, statement: p.statement.trim(), scope: p.scope, sourceType: p.sourceType, sourceRef: p.sourceRef,
    observedAt: isoTime(p.observedAt ?? nowIso), validFrom: isoTime(p.validFrom ?? nowIso),
    confidence: isInf ? 'inferred' : (p.confidence ?? (isUserAuth ? 'stated' : 'corroborated')), author: p.author.trim(),
    taint: p.taint ?? (p.sourceType === 'external_doc' ? 'external_untrusted' : 'clean'),
    clearance: p.clearance ?? (p.layer === 'm2' ? 'private' : p.layer === 'm3' ? 'workspace' : 'public'),
    ...(supersedes ? { supersedes } : {}), ...(p.topicKey?.trim() ? { topicKey: p.topicKey.trim() } : {}),
    ...(p.verbatimQuote ? { verbatimQuote: p.verbatimQuote.trim() } : {}), ...(p.workspacesSeen ? { workspacesSeen: [...p.workspacesSeen] } : {}),
    ...(p.seenCount !== undefined ? { seenCount: p.seenCount } : {}), ...(p.importance !== undefined ? { importance: p.importance } : {}),
    ...(p.lastAccessedAt ? { lastAccessedAt: isoTime(p.lastAccessedAt) } : {}), ...(p.triggerKeys ? { triggerKeys: p.triggerKeys } : {}),
    ...(p.m2Kind ? { m2Kind: p.m2Kind } : {}), ...(p.resident !== undefined ? { resident: p.resident } : {}),
  }
}

export interface MemoryWriterOptions {
  dir: string; lock: GitRepoLock; resolveRef?: (ref: SourceRef) => boolean | Promise<boolean>
  userName?: string; userEmail?: string; now?: () => Date; residentMaxChars?: number
  onAuditEvent?: (draft: SpineDraft<Record<string, unknown>>) => void
}

/** 唯一记忆写入服务（与 M0 共用 GitRepoLock），强守秘密拒写、防复活、CAS 并发锁与预算闸。 */
export class MemoryWriter {
  readonly dir: string; readonly lock: GitRepoLock; private readonly opts: MemoryWriterOptions; private initialized = false
  constructor(options: MemoryWriterOptions) {
    if (!options.lock) throw new Error('MemoryWriter 必须显式传入共享 GitRepoLock')
    this.dir = resolve(options.dir); this.lock = options.lock; this.opts = options
  }
  private now(): Date { return (this.opts.now ?? (() => new Date()))() }
  init(): Promise<void> { return this.lock.run(() => this.ensureInit()) }

  private emitAudit(type: 'memory.proposed' | 'memory.accepted' | 'memory.rejected' | 'memory.tombstoned',
    stream: `${string}:${string}`, author: string, payload: Record<string, unknown>, ref?: SourceRef, taint: SpineTaint = 'trusted'): void {
    if (!this.opts.onAuditEvent) return
    const safeAuthor = redactValue(author).value
    const draft: SpineDraft<Record<string, unknown>> = {
      id: `mem:audit:${type}:${randomUUID().slice(0, 12)}`, at: this.now().toISOString(), stream, type,
      source: { kind: safeAuthor === 'user' ? 'human' : safeAuthor.startsWith('secretary') ? 'secretary' : 'system', ref: safeAuthor },
      evidence: validRef(ref) ? [{ kind: 'event', ref: `m0:${ref.seq}#${ref.id}` }] : [], taint, payload,
    }
    this.opts.onAuditEvent(redactDraft(draft).draft)
  }

  private async git(args: string[]): Promise<string> {
    return (await execFileAsync('git', args, { cwd: this.dir, env: isolatedGitEnv(), maxBuffer: 8 * 1024 * 1024 })).stdout
  }
  private async ensureInit(): Promise<void> {
    if (this.initialized) return
    await mkdir(this.dir, { recursive: true })
    if (!existsSync(join(this.dir, '.git'))) await this.git(['init'])
    for (const [k, v] of [['user.name', this.opts.userName ?? 'dsh-memory'], ['user.email', this.opts.userEmail ?? 'memory@dsh.local']] as const) {
      if (!(await this.git(['config', '--local', '--get', '--', k]).then(s => s.trim(), () => ''))) await this.git(['config', '--local', '--', k, v])
    }
    this.initialized = true
  }
  private async commitPaths(relPaths: readonly string[], message: string): Promise<string | undefined> {
    if (!relPaths.length) return undefined
    await this.ensureInit(); await this.git(['add', '--', ...relPaths])
    if (!(await this.git(['diff', '--cached', '--name-only', '--', ...relPaths])).trim()) return undefined
    await this.git(['commit', '-m', message, '--', ...relPaths])
    return (await this.git(['rev-parse', 'HEAD'])).trim()
  }
  private async loadFactPage(layer: FactLayer, relPath: string, scope: MemoryScope, nowIso: string): Promise<FactPage> {
    const existing = await readMemoryPage(this.dir, relPath)
    if (existing) { if (existing.layer !== layer) throw new Error(`记忆页层级不匹配: ${relPath}`); return existing }
    return { version: 1, layer, pageKey: relPath.slice(0, -3), scope, revision: 0, updatedAt: nowIso, entries: [], changeLog: [] }
  }
  private async loadLedger(nowIso: string): Promise<LedgerPage> {
    const existing = await readMemoryPage(this.dir, 'm6/ledger.md')
    return existing?.layer === 'm6' ? existing : { version: 1, layer: 'm6', pageKey: 'm6/ledger', scope: 'global', revision: 0, updatedAt: nowIso, items: [], changeLog: [] }
  }
  private async writeAndCommit(pages: readonly [string, FactPage | LedgerPage][], message: string): Promise<string | undefined> {
    const snaps = new Map<string, string | null>()
    const rels = pages.map(([rel]) => rel)
    for (const rel of rels) {
      const abs = await assertSafeMemoryPath(this.dir, rel)
      snaps.set(abs, await readFile(abs, 'utf8').catch(e => ((e as NodeJS.ErrnoException).code === 'ENOENT' ? null : Promise.reject(e))))
    }
    try {
      for (const [rel, page] of pages) await writeMemoryPage(this.dir, rel, page)
      return await this.commitPaths(rels, message)
    } catch (err) {
      for (const [abs, prev] of snaps) await (prev === null ? rm(abs, { force: true }) : writeFile(abs, prev, 'utf8')).catch(() => {})
      await this.git(['reset', 'HEAD', '--', ...rels]).catch(() => this.git(['rm', '--cached', '--ignore-unmatch', '--', ...rels])).catch(() => {})
      throw err
    }
  }
  private async appendAttention(input: AttentionProposal, nowIso: string, author: string): Promise<{ item: AttentionItem; commit?: string }> {
    const ledger = await this.loadLedger(nowIso)
    const item: AttentionItem = {
      id: `att-${randomUUID().slice(0, 12)}`, kind: input.kind, status: 'pending', question: input.question.trim(),
      sourceRefs: [...input.sourceRefs], ...(input.conflictingEntryIds?.length ? { conflictingEntryIds: [...input.conflictingEntryIds] } : {}),
      ...(input.clearance ? { clearance: input.clearance } : {}), stickyTurns: input.stickyTurns ?? 2,
      cooldownMs: input.cooldownMs ?? 3_600_000, delaySeen: input.delaySeen ?? 1, seenCount: input.seenCount ?? 1, updatedAt: nowIso,
    }
    ledger.items.push(item); ledger.revision += 1; ledger.updatedAt = nowIso
    ledger.changeLog.push(formatChangeLogLine(nowIso, `m6:${item.kind}`, item.id, input.sourceRefs[0]!, author, item.question))
    return { item, commit: await this.writeAndCommit([['m6/ledger.md', ledger]], `m6: add ${item.kind} ${item.id}`) }
  }

  propose(proposal: MemoryProposal): Promise<WriteResult> {
    return this.lock.run(async () => {
      const stream = `memory:${proposal.layer}` as const
      const taint: SpineTaint = proposal.taint === 'external_untrusted' ? 'untrusted' : proposal.sourceType === 'inference' ? 'derived' : 'trusted'
      this.emitAudit('memory.proposed', stream, proposal.author ?? 'unknown', {
        layer: proposal.layer, scope: proposal.scope, sourceType: proposal.sourceType, statement: proposal.statement,
        ...(proposal.topicKey ? { topicKey: proposal.topicKey } : {}), ...(proposal.expectedRevision !== undefined ? { expectedRevision: proposal.expectedRevision } : {}),
      }, proposal.sourceRef, taint)
      const failAudit = (reason: WriteRejectReason, detail: string, extra?: { attentionItem?: AttentionItem; commit?: string }) => {
        this.emitAudit('memory.rejected', stream, proposal.author ?? 'unknown', { layer: proposal.layer, reason, detail }, proposal.sourceRef, taint)
        return reject(reason, detail, extra)
      }
      const checked = validateProposal(proposal)
      if ('error' in checked) {
        const err = checked.error as Extract<WriteResult, { kind: 'rejected' }>
        this.emitAudit('memory.rejected', stream, proposal.author ?? 'unknown', { layer: proposal.layer, reason: err.reason, detail: err.detail }, proposal.sourceRef, taint)
        return checked.error
      }
      if (this.opts.resolveRef && !(await this.opts.resolveRef(proposal.sourceRef))) return failAudit('unknown-source-ref', `sourceRef 未在事件脊中确认: seq=${proposal.sourceRef.seq}, id=${proposal.sourceRef.id}`)
      const now = this.now(), nowMs = now.getTime(), nowIso = now.toISOString()
      const targetPage = await this.loadFactPage(proposal.layer, checked.targetRel, proposal.scope, nowIso)
      if (proposal.expectedRevision !== undefined && proposal.expectedRevision !== targetPage.revision) {
        return failAudit('revision-conflict', `CAS 版本冲突: expectedRevision=${proposal.expectedRevision}, actual=${targetPage.revision}`)
      }
      const isInf = proposal.sourceType === 'inference' || proposal.author === 'consolidator' || proposal.author.startsWith('consolidator:')
      if (isInf) {
        const quote = (proposal.verbatimQuote ?? '').trim()
        if (quote.length < 4 || !(proposal.evidenceText ?? '').includes(quote)) {
          const att = await this.appendAttention({ kind: 'verification', sourceRefs: [proposal.sourceRef],
            question: `待核实巩固提议「${proposal.statement.trim()}」：逐字引证未在证据原文命中` }, nowIso, proposal.author)
          return failAudit('verbatim-quote-mismatch', '引证长度不足 4 或未在 evidenceText 逐字命中，已入 M6 待核队列', { attentionItem: att.item, commit: att.commit })
        }
      }
      const allEntries = (await listMemoryPages(this.dir, ['m1', 'm2', 'm3', 'm4']))
        .filter((p): p is { relPath: string; page: FactPage } => p.page.layer !== 'm6').flatMap(p => p.page.entries.map(entry => ({ relPath: p.relPath, page: p.page, entry })))
      const normStmt = normText(proposal.statement), normTopic = proposal.topicKey?.trim()
      const isUserAuth = !isInf && (proposal.sourceType === 'user_direct' || proposal.sourceType === 'user_ruling')
      const isOverride = isUserAuth && proposal.overrideTombstone === true
      const isActiveVeto = (e: MemoryEntry) => e.m2Kind === 'veto' && !e.invalidatedBy && (!e.validTo || Date.parse(e.validTo) > nowMs)
      const activeTopics = new Set(allEntries.filter(({ entry: e }) => !e.invalidatedBy && e.m2Kind !== 'veto' && (!e.validTo || Date.parse(e.validTo) > nowMs) && e.topicKey?.trim())
        .map(({ entry: e }) => `${e.scope}::${e.topicKey!.trim()}`))
      const tombHits = allEntries.filter(({ entry: e }) => {
        const activeVeto = isActiveVeto(e)
        if (!activeVeto && !e.invalidatedBy) return false
        if (!activeVeto && e.scope !== 'global' && e.scope !== proposal.scope) return false
        const sameStmt = normText(e.statement) === normStmt
        const deadTopic = Boolean(normTopic && e.topicKey?.trim() === normTopic) && (activeVeto || (e.scope === proposal.scope && !activeTopics.has(`${e.scope}::${normTopic}`)))
        return sameStmt || deadTopic
      })
      if (tombHits.length > 0 && !isOverride) return failAudit('tombstone-blocked', `命中防复活墓碑/否决条目 ${tombHits[0]!.entry.id}`)
      const activeConflicts = allEntries.filter(({ entry: e }) =>
        !e.invalidatedBy && (!e.validTo || Date.parse(e.validTo) > nowMs) && e.scope === proposal.scope && normTopic && e.topicKey?.trim() === normTopic && normText(e.statement) !== normStmt)
      const toInvalidate = [...tombHits.filter(c => isActiveVeto(c.entry)), ...activeConflicts].filter((c, i, arr) => arr.findIndex(x => x.entry.id === c.entry.id) === i)
      if (toInvalidate.length > 0 && !isUserAuth) {
        const att = await this.appendAttention({ kind: 'conflict', conflictingEntryIds: toInvalidate.map(c => c.entry.id),
          question: `主题 ${normTopic} 同级冲突：现行「${toInvalidate[0]!.entry.statement}」vs 新提议「${proposal.statement.trim()}」`,
          sourceRefs: [...toInvalidate.map(c => c.entry.sourceRef), proposal.sourceRef] }, nowIso, proposal.author)
        this.emitAudit('memory.rejected', stream, proposal.author, { layer: proposal.layer, reason: 'topic-conflict', attentionId: att.item.id }, proposal.sourceRef, taint)
        return { kind: 'conflict', reason: 'topic-conflict', detail: '同级冲突禁止自动选边，已记入 M6 冲突待裁队列', conflictingEntryIds: toInvalidate.map(c => c.entry.id), attentionItem: att.item, commit: att.commit }
      }
      const newId = `mem-${proposal.layer}-${randomUUID().slice(0, 12)}`, entry = buildEntry(proposal, newId, nowIso, isInf, isUserAuth, toInvalidate[0]?.entry.id)
      const maxResident = this.opts.residentMaxChars ?? DEFAULT_MEMORY_BUDGETS.residentMaxChars
      if (entry.resident === true) {
        const invalidIds = new Set(toInvalidate.map(c => c.entry.id))
        const activeResidents = allEntries.map(x => x.entry).filter(e => isEntryActiveAt(e, nowMs) && e.resident === true && !invalidIds.has(e.id))
        try { assertResidentBudget([...activeResidents, entry], maxResident) }
        catch (err) { if (err instanceof ResidentBudgetExceededError) return failAudit('resident-budget-exceeded', err.message); throw err }
      }
      const touched = new Map<string, FactPage>()
      for (const c of toInvalidate) {
        c.entry.validTo = nowIso; c.entry.invalidatedBy = newId; c.entry.invalidationReason = proposal.invalidationReason ?? `superseded by ${newId}`
        c.page.revision += 1; c.page.updatedAt = nowIso
        c.page.changeLog.push(formatChangeLogLine(nowIso, 'supersede', c.entry.id, proposal.sourceRef, proposal.author, c.entry.invalidationReason))
        touched.set(c.relPath, c.page)
      }
      const finalPage = touched.get(checked.targetRel) ?? targetPage
      finalPage.entries.push(entry); finalPage.revision += 1; finalPage.updatedAt = nowIso
      finalPage.changeLog.push(formatChangeLogLine(nowIso, 'accept', entry.id, proposal.sourceRef, proposal.author, entry.statement))
      touched.set(checked.targetRel, finalPage)
      const supersededIds = toInvalidate.map(c => c.entry.id)
      const commit = await this.writeAndCommit([...touched.entries()], `memory(${proposal.layer}): accept ${entry.id}`)
      this.emitAudit('memory.accepted', stream, proposal.author, { layer: proposal.layer, entryId: entry.id, pagePath: checked.targetRel, revision: finalPage.revision, supersededIds, ...(entry.m2Kind ? { m2Kind: entry.m2Kind } : {}) }, proposal.sourceRef, taint)
      return { kind: 'accepted', entry, pagePath: checked.targetRel, supersededIds, commit }
    })
  }

  tombstone(input: TombstoneInput): Promise<TombstoneResult> {
    return this.lock.run(async () => {
      const fail = (reason: string, msg: string): never => {
        this.emitAudit('memory.rejected', `memory:${input.target.layer}`, input.author ?? 'unknown', { layer: input.target.layer, entryId: input.entryId, reason, detail: msg }, input.sourceRef)
        throw new Error(msg)
      }
      if (!validRef(input.sourceRef) || hasSecret([input.reason, input.author, input.sourceRef.id])) fail('secret-or-missing-ref', 'tombstone 缺少合法 sourceRef 或含秘密形状')
      if (this.opts.resolveRef && !(await this.opts.resolveRef(input.sourceRef))) fail('unknown-source-ref', 'tombstone sourceRef 未在事件脊确认')
      const relPath = resolveMemoryRelPath(input.target), page = await readMemoryPage(this.dir, relPath)
      if (!page || page.layer === 'm6') fail('page-not-found', `未找到记忆页: ${relPath}`)
      const factPage = page as FactPage, entry = factPage.entries.find(e => e.id === input.entryId)
      if (!entry) fail('entry-not-found', `记忆页 ${relPath} 不存在条目 ${input.entryId}`)
      const targetEntry = entry!, nowIso = this.now().toISOString()
      targetEntry.validTo = nowIso; targetEntry.invalidatedBy = `tombstone:${input.sourceRef.id}`; targetEntry.invalidationReason = input.reason.trim()
      factPage.revision += 1; factPage.updatedAt = nowIso
      factPage.changeLog.push(formatChangeLogLine(nowIso, 'tombstone', targetEntry.id, input.sourceRef, input.author, targetEntry.invalidationReason))
      const commit = await this.writeAndCommit([[relPath, factPage]], `memory(${factPage.layer}): tombstone ${targetEntry.id}`)
      this.emitAudit('memory.tombstoned', `memory:${factPage.layer}`, input.author, { layer: factPage.layer, entryId: targetEntry.id, pagePath: relPath, reason: targetEntry.invalidationReason }, input.sourceRef)
      return { entry: targetEntry, pagePath: relPath, commit }
    })
  }

  upsertAttention(input: AttentionProposal, author = 'secretary'): Promise<{ item: AttentionItem; commit?: string }> {
    return this.lock.run(async () => {
      if (!input.sourceRefs.length || !input.sourceRefs.every(validRef) || hasSecret([input.question, author, ...input.sourceRefs.map(r => r.id), ...(input.conflictingEntryIds ?? [])])) {
        this.emitAudit('memory.rejected', 'memory:m6', author, { layer: 'm6', reason: 'secret-or-missing-ref' }, input.sourceRefs[0])
        throw new Error('M6 事项需要合法 sourceRef 且不得含秘密形状')
      }
      if (this.opts.resolveRef) {
        for (const r of input.sourceRefs) if (!(await this.opts.resolveRef(r))) {
          this.emitAudit('memory.rejected', 'memory:m6', author, { layer: 'm6', reason: 'unknown-source-ref' }, r); throw new Error(`M6 sourceRef 未确认: ${r.id}`)
        }
      }
      const res = await this.appendAttention(input, this.now().toISOString(), author)
      this.emitAudit('memory.proposed', 'memory:m6', author, { layer: 'm6', attentionId: res.item.id, kind: res.item.kind, status: res.item.status }, input.sourceRefs[0])
      return res
    })
  }

  transitionAttention(input: AttentionTransition, author = 'secretary'): Promise<{ item: AttentionItem; commit?: string }> {
    return this.lock.run(async () => {
      if (hasSecret([author])) { this.emitAudit('memory.rejected', 'memory:m6', 'redacted', { layer: 'm6', attentionId: input.id, reason: 'secret-detected' }); throw new Error('M6 操作者含秘密形状，拒绝写入') }
      const now = this.now(), nowIso = now.toISOString(), ledger = await this.loadLedger(nowIso), item = ledger.items.find(i => i.id === input.id)
      if (!item) { this.emitAudit('memory.rejected', 'memory:m6', author, { layer: 'm6', attentionId: input.id, reason: 'not-found' }); throw new Error(`M6 账本不存在事项: ${input.id}`) }
      const setCooldown = () => { if (item.cooldownMs > 0) item.cooldownUntil = new Date(now.getTime() + item.cooldownMs).toISOString() }
      if (input.action === 'seen') item.seenCount += 1
      else if (input.action === 'ask') { item.status = 'asked'; item.remainingStickyTurns = item.stickyTurns; if (item.stickyTurns <= 0) setCooldown() }
      else if (input.action === 'tick') { if ((item.remainingStickyTurns ?? 0) > 0 && --item.remainingStickyTurns! === 0) setCooldown() }
      else { item.status = input.action === 'dismiss' ? 'dismissed' : input.action === 'approve' ? 'approved' : 'expired'; item.remainingStickyTurns = 0; if (input.action === 'dismiss') setCooldown() }
      item.updatedAt = nowIso; ledger.revision += 1; ledger.updatedAt = nowIso
      ledger.changeLog.push(formatChangeLogLine(nowIso, `m6:${input.action}`, item.id, item.sourceRefs[0]!, author, item.status))
      const commit = await this.writeAndCommit([['m6/ledger.md', ledger]], `m6: ${input.action} ${item.id}`)
      const evType = input.action === 'dismiss' ? 'memory.rejected' : input.action === 'expire' ? 'memory.tombstoned' : 'memory.accepted'
      this.emitAudit(evType, 'memory:m6', author, { layer: 'm6', action: input.action, attentionId: item.id, status: item.status }, item.sourceRefs[0])
      return { item, commit }
    })
  }
}

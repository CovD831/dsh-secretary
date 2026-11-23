/** 可信记忆单写者服务：串行 GitRepoLock、秘密拒写门、M4 门槛与 A3 三关校验链。 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { isoTime } from '../core/model.ts'
import { GitRepoLock } from '../spine/git-sink.ts'
import { redactValue } from '../spine/redact.ts'
import type { SourceRef } from '../spine/types.ts'
import {
  formatChangeLogLine, listMemoryPages, readMemoryPage,
  resolveMemoryRelPath, writeMemoryPage,
} from './codec.ts'
import type {
  AttentionItem, AttentionProposal, AttentionTransition, FactLayer, FactPage,
  LedgerPage, MemoryEntry, MemoryProposal, MemoryScope, TombstoneInput,
  TombstoneResult, WriteRejectReason, WriteResult,
} from './types.ts'

const execFileAsync = promisify(execFile)
const ISOLATED_ENV_KEYS = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
  'GIT_AUTHOR_NAME', 'GIT_COMMITTER_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_EMAIL',
] as const

const normText = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ')
const validRef = (ref?: SourceRef): ref is SourceRef =>
  Boolean(ref && Number.isSafeInteger(ref.seq) && ref.seq > 0 && typeof ref.id === 'string' && ref.id.trim())
const hasSecret = (vals: readonly (string | undefined)[]): boolean =>
  vals.some(v => v !== undefined && redactValue(v).redacted.length > 0)
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
  if (hasSecret([p.statement, p.verbatimQuote, p.invalidationReason, p.topicKey, ...(p.triggerKeys?.primary ?? []), ...(p.triggerKeys?.secondary ?? [])])) {
    return { error: reject('secret-detected', '检测到秘密或凭据形状，已触发拒写门') }
  }
  if (!validRef(p.sourceRef)) return { error: reject('missing-source-ref', '缺少有效的 M0 sourceRef (seq > 0 且 id 非空)') }
  if (!p.statement.trim() || !p.author.trim()) return { error: reject('invalid-input', 'statement 与 author 不能为空') }
  if (p.importance !== undefined && (!Number.isFinite(p.importance) || p.importance < 0 || p.importance > 10)) return { error: reject('invalid-input', 'importance 须在 0–10 间') }
  if ((p.observedAt && !Number.isFinite(Date.parse(p.observedAt))) || (p.validFrom && !Number.isFinite(Date.parse(p.validFrom)))) {
    return { error: reject('invalid-input', 'observedAt 或 validFrom 时间戳非法') }
  }
  const validScope = p.scope === 'global' || /^workspace:[^\s]+$/.test(p.scope) || /^person:[^\s]+$/.test(p.scope)
  if (!validScope || (p.layer === 'm4' && p.scope !== 'global') || (p.layer === 'm2' && p.scope.startsWith('workspace:'))) {
    return { error: reject('scope-mismatch', `层级 ${p.layer} 不允许作用域 "${p.scope}"`) }
  }
  if (p.layer === 'm3' && (!p.scope.startsWith('workspace:') || (p.workspaceKey && p.workspaceKey !== p.scope.slice(10)))) {
    return { error: reject('scope-mismatch', `M3 作用域与 workspaceKey 不匹配: "${p.scope}"`) }
  }
  if (p.layer === 'm4') {
    const uniq = new Set((p.workspacesSeen ?? []).map(s => s.trim()).filter(Boolean))
    if ((uniq.size < 2 || (p.seenCount ?? 0) < 2) && p.sourceType !== 'user_ruling') {
      return { error: reject('m4-threshold-not-met', '写 M4 须满足 workspacesSeen 去重 >= 2 且 seenCount >= 2，或显式 user_ruling') }
    }
  }
  try {
    return { targetRel: resolveMemoryRelPath({ layer: p.layer, slug: p.slug, workspaceKey: p.layer === 'm3' ? (p.workspaceKey ?? p.scope.slice(10)) : undefined }) }
  } catch (err) {
    return { error: reject('invalid-input', err instanceof Error ? err.message : String(err)) }
  }
}

function buildEntry(p: MemoryProposal, id: string, nowIso: string, isInf: boolean, isUserAuth: boolean, supersedes?: string): MemoryEntry {
  return {
    id, statement: p.statement.trim(), scope: p.scope, sourceType: p.sourceType, sourceRef: p.sourceRef,
    observedAt: isoTime(p.observedAt ?? nowIso), validFrom: isoTime(p.validFrom ?? nowIso),
    confidence: isInf ? 'inferred' : (p.confidence ?? (isUserAuth ? 'stated' : 'corroborated')),
    author: p.author.trim(),
    taint: p.taint ?? (p.sourceType === 'external_doc' ? 'external_untrusted' : 'clean'),
    clearance: p.clearance ?? (p.layer === 'm2' ? 'private' : p.layer === 'm3' ? 'workspace' : 'public'),
    ...(supersedes ? { supersedes } : {}), ...(p.topicKey?.trim() ? { topicKey: p.topicKey.trim() } : {}),
    ...(p.verbatimQuote ? { verbatimQuote: p.verbatimQuote.trim() } : {}), ...(p.workspacesSeen ? { workspacesSeen: [...p.workspacesSeen] } : {}),
    ...(p.seenCount !== undefined ? { seenCount: p.seenCount } : {}), ...(p.importance !== undefined ? { importance: p.importance } : {}),
    ...(p.lastAccessedAt ? { lastAccessedAt: isoTime(p.lastAccessedAt) } : {}), ...(p.triggerKeys ? { triggerKeys: p.triggerKeys } : {}),
    ...(p.m2Kind ? { m2Kind: p.m2Kind } : {}), ...(p.resident !== undefined ? { resident: p.resident } : {}),
  }
}

export interface MemoryWriterOptions { dir: string; lock?: GitRepoLock; userName?: string; userEmail?: string; now?: () => Date }

/** 唯一记忆写入服务（与 M0 共用 GitRepoLock），强守秘密拒写、防复活与冲突转 M6 纪律。 */
export class MemoryWriter {
  readonly dir: string
  readonly lock: GitRepoLock
  private readonly userName: string
  private readonly userEmail: string
  private readonly now: () => Date
  private initialized = false

  constructor(options: MemoryWriterOptions) {
    this.dir = resolve(options.dir)
    this.lock = options.lock ?? new GitRepoLock()
    this.userName = options.userName ?? 'dsh-memory'
    this.userEmail = options.userEmail ?? 'memory@dsh.local'
    this.now = options.now ?? (() => new Date())
  }

  init(): Promise<void> { return this.lock.run(() => this.ensureInit()) }

  private async git(args: string[]): Promise<string> {
    return (await execFileAsync('git', args, { cwd: this.dir, env: isolatedGitEnv(), maxBuffer: 8 * 1024 * 1024 })).stdout
  }

  private async ensureInit(): Promise<void> {
    if (this.initialized) return
    await mkdir(this.dir, { recursive: true })
    if (!existsSync(join(this.dir, '.git'))) await this.git(['init'])
    for (const [k, v] of [['user.name', this.userName], ['user.email', this.userEmail]] as const) {
      if (!(await this.git(['config', '--local', '--get', '--', k]).then(s => s.trim(), () => ''))) await this.git(['config', '--local', '--', k, v])
    }
    this.initialized = true
  }

  private async commitPaths(relPaths: readonly string[], message: string): Promise<string | undefined> {
    if (!relPaths.length) return undefined
    await this.ensureInit()
    await this.git(['add', '--', ...relPaths])
    if (!(await this.git(['diff', '--cached', '--name-only', '--', ...relPaths])).trim()) return undefined
    await this.git(['commit', '-m', message, '--', ...relPaths])
    return (await this.git(['rev-parse', 'HEAD'])).trim()
  }

  private async loadFactPage(layer: FactLayer, relPath: string, scope: MemoryScope, nowIso: string): Promise<FactPage> {
    const existing = await readMemoryPage(this.dir, relPath)
    if (existing) {
      if (existing.layer !== layer) throw new Error(`记忆页层级不匹配: ${relPath}`)
      return existing
    }
    return { version: 1, layer, pageKey: relPath.slice(0, -3), scope, revision: 0, updatedAt: nowIso, entries: [], changeLog: [] }
  }

  private async loadLedger(nowIso: string): Promise<LedgerPage> {
    const existing = await readMemoryPage(this.dir, 'm6/ledger.md')
    return existing?.layer === 'm6' ? existing : { version: 1, layer: 'm6', pageKey: 'm6/ledger', scope: 'global', revision: 0, updatedAt: nowIso, items: [], changeLog: [] }
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
    await writeMemoryPage(this.dir, 'm6/ledger.md', ledger)
    return { item, commit: await this.commitPaths(['m6/ledger.md'], `m6: add ${item.kind} ${item.id}`) }
  }

  propose(proposal: MemoryProposal): Promise<WriteResult> {
    return this.lock.run(async () => {
      const checked = validateProposal(proposal)
      if ('error' in checked) return checked.error
      const now = this.now(), nowMs = now.getTime(), nowIso = now.toISOString()
      const isInf = proposal.sourceType === 'inference' || proposal.author === 'consolidator' || proposal.author.startsWith('consolidator:')
      if (isInf) {
        const quote = (proposal.verbatimQuote ?? '').trim()
        if (quote.length < 4 || !(proposal.evidenceText ?? '').includes(quote)) {
          const att = await this.appendAttention({
            kind: 'verification', sourceRefs: [proposal.sourceRef],
            question: `待核实巩固提议「${proposal.statement.trim()}」：逐字引证未在证据原文命中`,
          }, nowIso, proposal.author)
          return reject('verbatim-quote-mismatch', '引证长度不足 4 或未在 evidenceText 逐字命中，已入 M6 待核队列', { attentionItem: att.item, commit: att.commit })
        }
      }

      const allEntries = (await listMemoryPages(this.dir, ['m1', 'm2', 'm3', 'm4']))
        .filter((p): p is { relPath: string; page: FactPage } => p.page.layer !== 'm6')
        .flatMap(p => p.page.entries.map(entry => ({ relPath: p.relPath, page: p.page, entry })))
      const normStmt = normText(proposal.statement), normTopic = proposal.topicKey?.trim()
      const isUserAuth = proposal.sourceType === 'user_direct' || proposal.sourceType === 'user_ruling'
      const isOverride = isUserAuth && proposal.overrideTombstone === true
      const activeTopics = new Set(allEntries
        .filter(({ entry: e }) => !e.invalidatedBy && e.m2Kind !== 'veto' && (!e.validTo || Date.parse(e.validTo) > nowMs) && e.topicKey?.trim())
        .map(({ entry: e }) => `${e.scope}::${e.topicKey!.trim()}`))

      const conflicts = allEntries.filter(({ entry: e }) => {
        if (!e.invalidatedBy && e.m2Kind !== 'veto') return false
        const sameStmt = normText(e.statement) === normStmt
        const deadTopic = Boolean(normTopic && e.topicKey?.trim() === normTopic) && (e.m2Kind === 'veto' || (e.scope === proposal.scope && !activeTopics.has(`${e.scope}::${normTopic}`)))
        return sameStmt || deadTopic
      })
      if (conflicts.length > 0 && !isOverride) return reject('tombstone-blocked', `命中防复活墓碑/否决条目 ${conflicts[0]!.entry.id}`)

      const activeConflicts = allEntries.filter(({ entry: e }) =>
        !e.invalidatedBy && (!e.validTo || Date.parse(e.validTo) > nowMs) && e.scope === proposal.scope
        && normTopic && e.topicKey?.trim() === normTopic && normText(e.statement) !== normStmt)
      const toInvalidate = [...conflicts.filter(c => !c.entry.invalidatedBy && c.entry.m2Kind === 'veto'), ...activeConflicts]
        .filter((c, i, arr) => arr.findIndex(x => x.entry.id === c.entry.id) === i)

      if (toInvalidate.length > 0 && !isUserAuth) {
        const att = await this.appendAttention({
          kind: 'conflict', conflictingEntryIds: toInvalidate.map(c => c.entry.id),
          question: `主题 ${normTopic} 同级冲突：现行「${toInvalidate[0]!.entry.statement}」vs 新提议「${proposal.statement.trim()}」`,
          sourceRefs: [...toInvalidate.map(c => c.entry.sourceRef), proposal.sourceRef],
        }, nowIso, proposal.author)
        return { kind: 'conflict', reason: 'topic-conflict', detail: '同级冲突禁止自动选边，已记入 M6 冲突待裁队列', conflictingEntryIds: toInvalidate.map(c => c.entry.id), attentionItem: att.item, commit: att.commit }
      }

      const newId = `mem-${proposal.layer}-${randomUUID().slice(0, 12)}`
      const entry = buildEntry(proposal, newId, nowIso, isInf, isUserAuth, toInvalidate[0]?.entry.id)
      const touched = new Map<string, FactPage>()
      for (const c of toInvalidate) {
        c.entry.validTo = nowIso; c.entry.invalidatedBy = newId
        c.entry.invalidationReason = proposal.invalidationReason ?? `superseded by ${newId}`
        c.page.revision += 1; c.page.updatedAt = nowIso
        c.page.changeLog.push(formatChangeLogLine(nowIso, 'supersede', c.entry.id, proposal.sourceRef, proposal.author, c.entry.invalidationReason))
        touched.set(c.relPath, c.page)
      }
      const targetPage = touched.get(checked.targetRel) ?? await this.loadFactPage(proposal.layer, checked.targetRel, proposal.scope, nowIso)
      targetPage.entries.push(entry); targetPage.revision += 1; targetPage.updatedAt = nowIso
      targetPage.changeLog.push(formatChangeLogLine(nowIso, 'accept', entry.id, proposal.sourceRef, proposal.author, entry.statement))
      touched.set(checked.targetRel, targetPage)
      for (const [relPath, page] of touched) await writeMemoryPage(this.dir, relPath, page)
      return { kind: 'accepted', entry, pagePath: checked.targetRel, supersededIds: toInvalidate.map(c => c.entry.id), commit: await this.commitPaths([...touched.keys()], `memory(${proposal.layer}): accept ${entry.id}`) }
    })
  }

  tombstone(input: TombstoneInput): Promise<TombstoneResult> {
    return this.lock.run(async () => {
      if (!validRef(input.sourceRef) || hasSecret([input.reason])) throw new Error('tombstone 缺少合法 sourceRef 或含秘密形状')
      const relPath = resolveMemoryRelPath(input.target)
      const page = await readMemoryPage(this.dir, relPath)
      if (!page || page.layer === 'm6') throw new Error(`未找到记忆页: ${relPath}`)
      const entry = page.entries.find(e => e.id === input.entryId)
      if (!entry) throw new Error(`记忆页 ${relPath} 不存在条目 ${input.entryId}`)
      const nowIso = this.now().toISOString()
      entry.validTo = nowIso; entry.invalidatedBy = `tombstone:${input.sourceRef.id}`; entry.invalidationReason = input.reason.trim()
      page.revision += 1; page.updatedAt = nowIso
      page.changeLog.push(formatChangeLogLine(nowIso, 'tombstone', entry.id, input.sourceRef, input.author, entry.invalidationReason))
      await writeMemoryPage(this.dir, relPath, page)
      return { entry, pagePath: relPath, commit: await this.commitPaths([relPath], `memory(${page.layer}): tombstone ${entry.id}`) }
    })
  }

  upsertAttention(input: AttentionProposal, author = 'secretary'): Promise<{ item: AttentionItem; commit?: string }> {
    return this.lock.run(async () => {
      if (!input.sourceRefs.length || !input.sourceRefs.every(validRef) || hasSecret([input.question])) throw new Error('M6 事项需要合法 sourceRef 且不得含秘密形状')
      return this.appendAttention(input, this.now().toISOString(), author)
    })
  }

  transitionAttention(input: AttentionTransition, author = 'secretary'): Promise<{ item: AttentionItem; commit?: string }> {
    return this.lock.run(async () => {
      const now = this.now(), nowIso = now.toISOString(), ledger = await this.loadLedger(nowIso)
      const item = ledger.items.find(i => i.id === input.id)
      if (!item) throw new Error(`M6 账本不存在事项: ${input.id}`)
      const setCooldown = () => { if (item.cooldownMs > 0) item.cooldownUntil = new Date(now.getTime() + item.cooldownMs).toISOString() }
      if (input.action === 'seen') item.seenCount += 1
      else if (input.action === 'ask') { item.status = 'asked'; item.remainingStickyTurns = item.stickyTurns; if (item.stickyTurns <= 0) setCooldown() }
      else if (input.action === 'tick') { if ((item.remainingStickyTurns ?? 0) > 0 && --item.remainingStickyTurns! === 0) setCooldown() }
      else {
        item.status = input.action === 'dismiss' ? 'dismissed' : input.action === 'approve' ? 'approved' : 'expired'
        item.remainingStickyTurns = 0
        if (input.action === 'dismiss') setCooldown()
      }
      item.updatedAt = nowIso; ledger.revision += 1; ledger.updatedAt = nowIso
      ledger.changeLog.push(formatChangeLogLine(nowIso, `m6:${input.action}`, item.id, item.sourceRefs[0]!, author, item.status))
      await writeMemoryPage(this.dir, 'm6/ledger.md', ledger)
      return { item, commit: await this.commitPaths(['m6/ledger.md'], `m6: ${input.action} ${item.id}`) }
    })
  }
}

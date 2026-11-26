/** 零执行秘书治理工具 Zod Schema 抽离模块（记忆召回、M0 溯源提议、M6 账本流转与沉淀作者面）。 */
import { z } from 'zod'
import type { ParamSpec } from '../../judgement/index.ts'
import type { MemoryScope } from '../../memory/index.ts'

export const SourceRefSchema = z.object({ seq: z.number(), id: z.string() }).strict()

export const RecallSchema = z.object({
  query: z.string().default(''),
  recent_messages: z.array(z.string()).optional(),
  budgets: z.object({
    residentMaxChars: z.number().optional(),
    triggeredMaxChars: z.number().optional(),
    retrievedMaxChars: z.number().optional(),
    attentionMaxChars: z.number().optional(),
  }).strict().optional(),
}).strict()

// 移除 user_ruling/user_direct、override_tombstone 与自由 author，防止提示注入伪造老板权威。
export const ProposeSchema = z.object({
  mode: z.enum(['propose', 'tombstone']).default('propose'),
  layer: z.enum(['m1', 'm2', 'm3']),
  slug: z.string().optional(),
  workspace_key: z.string().optional(),
  source_ref: SourceRefSchema.optional(),
  trigger_id: z.string().min(1).optional().describe('老板消息 trigger_id，自动从 M0 定位真实 source_ref'),
  statement: z.string().optional(),
  scope: z.string().optional().describe('global / person:<id> / workspace:<key>'),
  source_type: z.enum(['session', 'inference']).optional(),
  topic_key: z.string().optional(),
  clearance: z.enum(['public', 'workspace', 'private']).optional(),
  m2_kind: z.enum(['preference', 'veto', 'shared_event', 'internal_moniker', 'correction_repair']).optional(),
  resident: z.boolean().optional(),
  importance: z.number().optional(),
  verbatim_quote: z.string().optional(),
  evidence_text: z.string().optional(),
  trigger_keys: z.object({
    primary: z.array(z.string()),
    secondary: z.array(z.string()).optional(),
    logic: z.enum(['AND_ANY', 'AND_ALL', 'NOT_ANY', 'NOT_ALL']).optional(),
  }).strict().optional(),
  entry_id: z.string().optional(),
  reason: z.string().optional(),
}).strict().refine(v => Boolean(v.source_ref || v.trigger_id), {
  message: '必须提供 source_ref 或 trigger_id 之一',
})

export const LedgerSchema = z.object({
  mode: z.enum(['list', 'transition']).default('list'),
  status: z.enum(['pending', 'asked', 'approved', 'dismissed', 'expired']).optional(),
  id: z.string().optional(),
  next_status: z.enum(['asked', 'approved', 'dismissed']).optional(),
  source_ref: SourceRefSchema.optional(),
}).strict()

export const MandateSchema = z.object({
  strength: z.enum(['explicit', 'delegated', 'inferred']),
  scope: z.string(),
  policyVersion: z.string(),
  ceiling: z.enum(['read', 'draft', 'local-write', 'commit', 'push-branch', 'outward-post', 'merge']),
  isolation: z.enum(['I1', 'I2', 'I3', 'I4', 'I5']),
}).strict()

export const DraftSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  version: z.number().optional(),
  author: z.string().optional(),
  scope: z.string().optional(),
  kind: z.enum(['gate', 'standing-order', 'evaluator', 'counter-rule']).optional(),
  level: z.enum(['object', 'meta']).optional(),
  point: z.string().optional().describe('挂载点 <scope>.<stage>'),
  requires: z.array(z.string()).optional(),
  params: z.record(z.string(), z.unknown()).optional().describe('ParamSpec 字典'),
  exceptions: z.array(z.string()).optional(),
  repairHint: z.string().optional(),
  intent: z.string().optional(),
  rubricBody: z.string().optional(),
  enforce: z.boolean().optional(),
  stage: z.enum(['shadow', 'observe', 'enforce', 'retired']).optional(),
  mandateCeiling: z.enum(['L0', 'L1', 'L2', 'L3']).optional(),
  actionClass: z.enum(['observe', 'block', 'side-effecting']).optional(),
  mandateRef: z.string().optional(),
  action: z.object({ name: z.string(), params: z.unknown().optional() }).strict().optional(),
  trigger: z.object({
    on: z.string().optional(),
    workspace: z.string().optional(),
    globs: z.array(z.string()).optional(),
    mode: z.enum(['always', 'on-event', 'scheduled-sweep']).optional(),
    signal: z.string().optional(),
    match: z.record(z.string(), z.unknown()).optional(),
  }).strict().optional(),
  origin: z.object({ kind: z.enum(['user-authored', 'friction-mined', 'forked']), refs: z.array(z.string()).optional() }).strict().optional(),
  cases: z.array(z.object({
    name: z.string(),
    expected: z.enum(['allow', 'deny', 'unmeasured']),
    ctx: z.unknown(),
    expectedCause: z.string().optional(),
    note: z.string().optional(),
  }).strict()).optional(),
  unansweredSlots: z.array(z.string()).optional(),
  rule: z.record(z.string(), z.unknown()).optional().describe('声明式规则: command_check | path_rules | predicates | workflow_sop'),
  measures: z.string().optional(),
  mandate: MandateSchema.optional(),
  playbook: z.record(z.string(), z.unknown()).optional(),
}).strict()

export type RawDraft = z.infer<typeof DraftSchema>

export const DepositSchema = z.object({
  mode: z.enum(['list_drafts', 'validate', 'replay', 'install_shadow']),
  draft: DraftSchema.optional(),
  include_online_candidates: z.boolean().optional(),
  cases: z.array(z.object({
    id: z.string(),
    family: z.string(),
    input: z.unknown(),
    expectedOutcome: z.enum(['defect', 'clean', 'unknown']),
    tokens: z.number().optional(),
    durationMs: z.number().optional(),
  }).strict()).optional(),
}).strict()

export function ruleCtxHint(ruleKind: unknown): string {
  if (ruleKind === 'command_check') return 'command_check 默认读取 ctx.commands 数组，正例 ctx 形如 { "commands": [{ "command": "tsc --noEmit", "exitCode": 0 }] }，反例缺该命令或 exitCode !== 0'
  if (ruleKind === 'path_rules') return 'path_rules 默认读取 ctx.changedPaths 字符串数组，正例 ["src/ok.ts"]，反例 ["a/tmp/bad.ts"]'
  if (ruleKind === 'predicates') return 'predicates 按 predicates[].path 读取 ctx 对应路径并做比较'
  return '请核对 rule.kind 与 cases[].ctx 字段路径是否一致，并确保至少 1 条 allow 与 1 条 deny 用例'
}

export function normalizeMemoryScope(layer: 'm1' | 'm2' | 'm3', rawScope?: string, workspaceKey?: string): MemoryScope {
  const trimmed = rawScope?.trim()
  if (trimmed === 'global' || trimmed?.startsWith('person:') || trimmed?.startsWith('workspace:')) return trimmed as MemoryScope
  if (layer === 'm3' && workspaceKey?.trim()) return `workspace:${workspaceKey.trim()}`
  if (trimmed === 'boss') return 'person:boss'
  return 'global'
}

export function extractDefaultParams(specs: Readonly<Record<string, ParamSpec>> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, spec] of Object.entries(specs ?? {})) {
    if (spec && typeof spec === 'object' && 'default' in spec && spec.default !== undefined) out[k] = spec.default
  }
  return out
}

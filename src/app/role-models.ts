/** Resolves and seeds per-role default models on newly created sessions without mutating the global DSH default. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { RoleModel } from '../policy.ts'

/** Resolve a configured route through the live provider; catalog membership is not a restriction. */
export async function resolveRoleModel(ctx: Context, model: RoleModel): Promise<ModelSelection> {
  const value = await ctx.llm.resolveCallConfig({ provider: model.provider, model: model.model,
    ...(model.reasoningEffort ? { reasoningEffort: ReasoningEffortId(model.reasoningEffort) } : {}) })
  return { provider: value.provider, model: value.model, ...(value.reasoningEffort ? { reasoningEffort: value.reasoningEffort } : {}) }
}

/** Seed a role's configured model onto a brand-new session before its first step, leaving later manual or durable selections intact. */
export async function initializeRoleModel(ctx: Context, agent: Agent, model: RoleModel | null): Promise<void> {
  if (!model) return
  if (agent.session.requestHeader() || agent.session.snapshotEvents().some(event => event.type === 'model/selection')) return
  const selected = await resolveRoleModel(ctx, model)
  // Avoid sessionController.selectModel() because it mutates the global DSH default; select only on this Agent's model.
  if (agent.model) agent.model.select(selected)
  else agent.session.append('model/selection', selected)
  await ctx.sessionPersistence.flush()
}

/** Switch a worker session's `reasoningEffort` per adaptive dispatch tier; falls back cleanly when the provider model lacks reasoning support. */
export async function applyThinkingTier(
  ctx: Context,
  agent: Agent,
  configured: RoleModel | null,
  tier?: 'low' | 'medium' | 'high',
): Promise<ModelSelection | undefined> {
  if (!tier) return undefined
  let base: { provider: string; model: string } | undefined = configured
    ? { provider: configured.provider, model: configured.model }
    : undefined
  const curModel = agent.model?.current?.()
  if (!base && curModel) {
    base = { provider: curModel.provider, model: curModel.model }
  }
  if (!base && ctx.sessionController?.modelCatalog) {
    const catalog = await ctx.sessionController.modelCatalog().catch(() => undefined)
    if (catalog?.default) base = { provider: catalog.default.provider, model: catalog.default.model }
  }
  if (!base) return undefined
  let selected: ModelSelection
  try {
    selected = await resolveRoleModel(ctx, { ...base, reasoningEffort: tier })
  } catch {
    selected = await resolveRoleModel(ctx, base)
  }
  if (agent.model) agent.model.select(selected)
  else agent.session.append('model/selection', selected)
  await ctx.sessionPersistence.flush()
  return selected
}

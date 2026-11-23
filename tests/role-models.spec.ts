import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { AgentModel, agentEvents, installModelSelection, type Agent, type ModelSelection, type ModelSelectionProjectionState } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { initializeRoleModel } from '../src/app/role-models.ts'

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())); vi.restoreAllMocks() })

async function fixture() {
  const ctx = new Context(); contexts.push(ctx); await ctx.plugin(SystemPrompt)
  const resolve = vi.fn(async value => value)
  const flush = vi.fn(async () => {})
  ctx.reflect.provide('llm', { resolveCallConfig: resolve })
  ctx.reflect.provide('sessionPersistence', { flush })
  const session = Session.create(SessionId('role-model'))
  const options = { provider: 'host', model: 'default', reasoningEffort: ReasoningEffortId('high') }
  const stateOf = (): ModelSelectionProjectionState => {
    let lastUsed: ModelSelection | null = null
    let pending: ModelSelection | null = null
    for (const event of session.snapshotEvents()) {
      if (event.type === 'model/selection') pending = event.data
      else if (event.type === 'request/header') {
        lastUsed = event.data.header.config
        if (pending && pending.provider === lastUsed.provider && pending.model === lastUsed.model && pending.reasoningEffort === lastUsed.reasoningEffort) {
          pending = null
        }
      }
    }
    return { lastUsed, pending }
  }
  const model = new AgentModel(stateOf, session, options)
  const agent = { id: session.id, ctx, session, model, options } as unknown as Agent
  installModelSelection(ctx)
  const input = createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })
  const preStep = (selection: ModelSelection) => agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { turn: 1, step: 1, messages: [input], signal: new AbortController().signal, modelSelection: selection },
    async () => ({ kind: 'enter' as const, messages: [input] }),
  )
  const record = (selection: ModelSelection) => {
    const event = session.append('request/header', { header: { config: selection }, reason: 'initial' })
    ctx.emit('session/event', session, event)
  }
  return { ctx, agent, options, resolve, flush, preStep, record }
}

it('selects the role model on the agent without mutating the host default', async () => {
  const { ctx, agent, options, flush, record } = await fixture()
  await initializeRoleModel(ctx, agent, { provider: 'worker-provider', model: 'worker-model' })
  expect(agent.model.current()).toEqual({ provider: 'worker-provider', model: 'worker-model' })
  expect(options).toEqual({ provider: 'host', model: 'default', reasoningEffort: 'high' })
  expect(agent.session.snapshotEvents().some(event => event.type === 'model/selection')).toBe(true)
  expect(flush).toHaveBeenCalledOnce()
  record({ provider: 'worker-provider', model: 'worker-model' })
  expect(agent.model.current()).toEqual({ provider: 'worker-provider', model: 'worker-model' })
})

it('lets a later explicit selection win and triggers DSH model-switch notice', async () => {
  const { ctx, agent, record, preStep } = await fixture()
  await initializeRoleModel(ctx, agent, { provider: 'worker', model: 'one' })
  record({ provider: 'worker', model: 'one' })
  const manual = { provider: 'manual', model: 'two', reasoningEffort: ReasoningEffortId('low') }
  agent.model.select(manual)
  expect(agent.model.current()).toEqual(manual)
  const decision = await preStep(agent.model.current()!)
  expect(decision.kind).toBe('enter')
  if (decision.kind === 'enter') {
    expect(decision.messages.some(m => m.source.kind === 'model-selection')).toBe(true)
  }
})

it.each(['header', 'selection'])('preserves a resumed Session with existing %s', async kind => {
  const { ctx, agent, resolve } = await fixture()
  const existing = { provider: 'existing', model: 'keep' }
  if (kind === 'header') agent.session.append('request/header', { header: { config: existing }, reason: 'initial' })
  else agent.session.append('model/selection', existing)
  await initializeRoleModel(ctx, agent, { provider: 'worker', model: 'new' })
  expect(resolve).not.toHaveBeenCalled()
  expect(agent.model.current()).toEqual(existing)
})

it('inherits the host when unset and fails unavailable routes before recording a selection', async () => {
  const { ctx, agent, resolve } = await fixture()
  await initializeRoleModel(ctx, agent, null)
  expect(agent.model.current()).toMatchObject({ provider: 'host', model: 'default' })
  resolve.mockRejectedValueOnce(new Error('unknown provider'))
  await expect(initializeRoleModel(ctx, agent, { provider: 'unknown', model: 'x' })).rejects.toThrow('unknown provider')
  expect(agent.session.snapshotEvents().some(event => event.type === 'model/selection')).toBe(false)
})

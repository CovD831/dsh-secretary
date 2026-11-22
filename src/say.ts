// DEPS: src/constants, src/events, src/host-types (仅类型)
// RESPONSIBILITY: 校验一句话并落秘书说话事件
// MODULE: secretary
// ---
import { KINDS, MAX_LINE_LENGTH, MOODS, TOOL_NAMES } from './constants.js'
import { LogWriter, pluginEvent } from './events.js'
import type { Agent } from './host-types.js'

export type Mood = typeof MOODS[number]
export interface SayArgs { line: string; mood: Mood }

export async function say(writer: LogWriter, agent: Pick<Agent, 'id'>, args: SayArgs): Promise<{ accepted: true }> {
  if (args.line.length === 0 || args.line.length > MAX_LINE_LENGTH) throw new Error(`一句话须为 1 至 ${MAX_LINE_LENGTH} 字。`)
  if (!MOODS.includes(args.mood)) throw new Error('表情标签不在允许范围内。')
  await writer.append(pluginEvent(KINDS.secretarySay, agent.id, { text: args.line, mood: args.mood }), true)
  return { accepted: true }
}

export interface AskOption { id: string; label: string; consequence: string; recommended: boolean }
export interface AskArgs { text: string; options: AskOption[]; allowNote: boolean }
export interface HandoverArgs { conclusion: string; reason: string; impact: string; evidence: string[] }

export async function ask(writer: LogWriter, agent: Pick<Agent, 'id'>, args: AskArgs): Promise<{ eventId: string }> {
  if (args.text.length === 0 || args.text.length > MAX_LINE_LENGTH) throw new Error(`问题须为 1 至 ${MAX_LINE_LENGTH} 字。`)
  if (args.options.length === 0 || args.options.length > 3) throw new Error('选项须为 1 至 3 项。')
  for (const option of args.options) {
    if (option.id.length === 0 || option.label.length === 0 || option.consequence.length === 0) {
      throw new Error('每项选项的 id、标签和后果均不能为空。')
    }
  }
  if (new Set(args.options.map(option => option.id)).size !== args.options.length) throw new Error('选项 id 不能重复。')
  if (args.options.filter(option => option.recommended).length > 1) throw new Error('最多只能有一个推荐选项。')
  const event = pluginEvent(KINDS.secretaryAsk, agent.id, { ...args })
  await writer.append(event, true)
  return { eventId: event.id }
}

export async function handover(writer: LogWriter, agent: Pick<Agent, 'id'>, args: HandoverArgs): Promise<{ eventId: string }> {
  for (const [name, value] of [['结论', args.conclusion], ['理由', args.reason], ['影响', args.impact]] as const) {
    if (value.length === 0 || value.length > 200) throw new Error(`${name}须为 1 至 200 字。`)
  }
  if (args.evidence.some(ref => ref.length === 0)) throw new Error('证据引用不能为空。')
  const event = pluginEvent(KINDS.secretaryHandover, agent.id, {
    title: args.conclusion, conclusion: args.conclusion, rationale: args.reason,
    impact: args.impact, evidenceRefs: args.evidence,
  })
  await writer.append(event, true)
  return { eventId: event.id }
}

export function createSpeechTools(writer: LogWriter): unknown[] {
  return [
    {
      name: TOOL_NAMES.ask,
      description: '向老板提出一个最多 3 个选项的问题，选项须说明后果，最多推荐一项。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', minLength: 1, maxLength: MAX_LINE_LENGTH },
          options: {
            type: 'array', minItems: 1, maxItems: 3,
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', minLength: 1 },
                label: { type: 'string', minLength: 1 },
                consequence: { type: 'string', minLength: 1 },
                recommended: { type: 'boolean' },
              },
              required: ['id', 'label', 'consequence', 'recommended'], additionalProperties: false,
            },
          },
          allowNote: { type: 'boolean' },
        },
        required: ['text', 'options', 'allowNote'], additionalProperties: false,
      },
      output: {
        schema: { type: 'object', properties: { eventId: { type: 'string' } }, required: ['eventId'] },
        render: () => [{ type: 'text', text: '已记录这个问题。' }],
      },
      execute: (args: AskArgs, exec: { agent?: Agent }) => {
        if (exec.agent === undefined) throw new Error('提问工具必须在秘书会话中调用。')
        return ask(writer, exec.agent, args)
      },
    },
    {
      name: TOOL_NAMES.handover,
      description: '向老板递交结论、理由、影响及证据引用。',
      parameters: {
        type: 'object',
        properties: {
          conclusion: { type: 'string', minLength: 1, maxLength: 200 },
          reason: { type: 'string', minLength: 1, maxLength: 200 },
          impact: { type: 'string', minLength: 1, maxLength: 200 },
          evidence: { type: 'array', items: { type: 'string', minLength: 1 } },
        },
        required: ['conclusion', 'reason', 'impact', 'evidence'], additionalProperties: false,
      },
      output: {
        schema: { type: 'object', properties: { eventId: { type: 'string' } }, required: ['eventId'] },
        render: () => [{ type: 'text', text: '已记录这份文件。' }],
      },
      execute: (args: HandoverArgs, exec: { agent?: Agent }) => {
        if (exec.agent === undefined) throw new Error('递交工具必须在秘书会话中调用。')
        return handover(writer, exec.agent, args)
      },
    },
  ]
}

function createSayTool(writer: LogWriter): unknown {
  return {
    name: TOOL_NAMES.say,
    description: '向老板说一句不超过 40 字的话，并指定表情。',
    parameters: {
      type: 'object',
      properties: {
        line: { type: 'string', minLength: 1, maxLength: MAX_LINE_LENGTH },
        mood: { type: 'string', enum: [...MOODS] },
      },
      required: ['line', 'mood'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { accepted: { type: 'boolean', enum: [true] } }, required: ['accepted'] },
      render: () => [{ type: 'text', text: '已记录这句话。' }],
    },
    execute: (args: SayArgs, exec: { agent?: Agent }) => {
      if (exec.agent === undefined) throw new Error('说话工具必须在秘书会话中调用。')
      return say(writer, exec.agent, args)
    },
  }
}

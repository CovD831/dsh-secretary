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

export function createSayTool(writer: LogWriter): unknown {
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

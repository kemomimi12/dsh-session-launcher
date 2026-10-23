/**
 * Session Launcher — 新建 Harness 会话并自动塞入开场提示词。
 *
 * 用途：长任务上下文快满时，由当前 Agent 主动开一个新会话，
 * 把「交接单 + 起始指令」一次性发进去，用户只需切过去继续。
 *
 * 依赖 Host Service：
 *   - tools              注册 Tool
 *   - sessionController  创建会话 / 发送 prompt
 */

import { randomUUID } from 'node:crypto'

export const name = 'session-launcher'

export const inject = ['tools', 'sessionController']

export function apply(ctx, config = {}) {
  const defaultCwd = config.cwd
  const defaultPrompt = config.defaultPrompt

  ctx.effect(() =>
    ctx.tools.register({
      name: 'new_session',
      description:
        'Create a new Harness session (a fresh context window) and optionally send an opening prompt into it. ' +
        'Use this when the current session context is nearly full and the work must continue elsewhere. ' +
        'Returns the new session id; the new session starts running as soon as the prompt is admitted, ' +
        'so this tool cannot observe its progress afterwards.',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description:
              'Opening prompt sent into the new session, exactly as if the user typed it. ' +
              'Omit to create an empty session the user will fill in.',
          },
          cwd: {
            type: 'string',
            description:
              'Working directory of the new session. Defaults to the plugin config value, ' +
              'then to the current session working directory.',
          },
          title: {
            type: 'string',
            description: 'Optional title for the new session, applied after creation.',
          },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            sessionId: { type: 'string' },
            prompted: { type: 'boolean' },
            cwd: { type: 'string' },
          },
          required: ['sessionId', 'prompted'],
          additionalProperties: false,
        },
        render(_args, value) {
          const lines = [
            `已创建新会话：${value.sessionId}`,
            value.prompted ? '开场提示词已发送，新会话已开始运行。' : '未发送开场提示词，新会话为空。',
            value.cwd ? `工作目录：${value.cwd}` : '',
            '',
            '请到左侧会话列表切换过去查看进度——本工具无法观察该会话的后续状态。',
          ]
          return [{ type: 'text', text: lines.filter(Boolean).join('\n') }]
        },
      },

      async execute(args, exec) {
        const session = ctx.sessionController
        if (!session) throw new Error('sessionController 不可用，无法创建会话')

        const prompt = typeof args.prompt === 'string' && args.prompt.trim() ? args.prompt : defaultPrompt
        const cwd = typeof args.cwd === 'string' && args.cwd.trim() ? args.cwd : defaultCwd

        // 1、创建会话
        const created = await session.create(cwd ? { cwd } : {})
        const sessionId = created?.sessionId
        if (!sessionId) throw new Error('创建会话失败：未返回 sessionId')

        // 2、可选：设置标题
        if (typeof args.title === 'string' && args.title.trim()) {
          try {
            await session.rename({ sessionId, title: args.title.trim() })
          } catch {
            // 标题失败不影响主流程
          }
        }

        // 3、可选：发送开场提示词
        //    prompt 的第二个参数是 signal；这里不传 exec.signal，
        //    因为工具调用结束后该 signal 会被 abort，会把刚提交的 prompt 一起取消。
        let prompted = false
        if (prompt) {
          const signal = new AbortController().signal
          await session.prompt(
            {
              requestId: randomUUID(),
              sessionId,
              mode: 'queue',
              content: [{ type: 'text', text: prompt }],
            },
            signal,
          )
          prompted = true
        }

        return { sessionId, prompted, cwd: cwd || undefined }
      },
    }),
  )
}

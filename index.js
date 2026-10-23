/**
 * Session Launcher — 新建 Harness 会话，自动继承工作区并塞入开场提示词。
 *
 * 用途：长任务上下文快满时，由当前 Agent 主动开一个新会话，
 * 新会话自动落在同一个工作区（分组 + 目录），开场白一次性发进去。
 *
 * 依赖 Host Service：
 *   - tools              注册 Tool
 *   - sessionController  创建会话 / 重命名 / 发送 prompt
 *   - workingDirectory   读取当前会话的生效目录（继承用）
 *   - workspaceRegistry  解析 / 创建工作区（分组用）
 */

import { randomUUID } from 'node:crypto'

export const name = 'session-launcher'

// 只声明硬依赖；workingDirectory / workspaceRegistry 通过 ctx.get() 可选获取。
export const inject = ['tools', 'sessionController']

/**
 * prompt / ensure 需要一个 AbortSignal。
 * 不能复用工具调用的 exec.signal：工具返回后它会被 abort，
 * 把刚提交的 prompt 一起取消掉（实测会报 throwIfAborted）。
 */
function detachedSignal() {
  return new AbortController().signal
}

export function apply(ctx, config = {}) {
  const defaultCwd = config.cwd
  const defaultPrompt = config.defaultPrompt
  const inheritWorkspace = config.inheritWorkspace !== false

  ctx.effect(() =>
    ctx.tools.register({
      name: 'new_session',
      description:
        'Create a new Harness session (a fresh context window) and optionally send an opening prompt into it. ' +
        'By default the new session inherits the caller\'s working directory AND is attached to the same workspace group, ' +
        'so it appears next to this conversation in the sidebar. ' +
        'Use this when the current session context is nearly full and the work must continue elsewhere. ' +
        'Pass cwd explicitly when the continuation belongs to a different project. ' +
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
              'Absolute working directory for the new session. Omit to inherit the caller\'s current directory. ' +
              'Set it only when the continuation belongs to a different project.',
          },
          title: {
            type: 'string',
            description: 'Optional title for the new session, applied after creation.',
          },
          inheritWorkspace: {
            type: 'boolean',
            description:
              'Attach the new session to the caller\'s workspace group. Defaults to the plugin config (true). ' +
              'Set false only for an intentionally ungrouped session.',
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
            workspace: { type: 'string' },
            inherited: { type: 'boolean' },
          },
          required: ['sessionId', 'prompted', 'inherited'],
          additionalProperties: false,
        },
        render(_args, value) {
          const lines = [
            `已创建新会话：${value.sessionId}`,
            value.prompted ? '开场提示词已发送，新会话已开始运行。' : '未发送开场提示词，新会话为空。',
            value.cwd
              ? `工作目录：${value.cwd}${value.inherited ? '（继承自当前会话）' : '（显式指定）'}`
              : '',
            value.workspace ? `工作区：${value.workspace}` : '工作区：未分组',
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
        const explicitCwd = typeof args.cwd === 'string' && args.cwd.trim() ? args.cwd.trim() : undefined
        const wantWorkspace =
          typeof args.inheritWorkspace === 'boolean' ? args.inheritWorkspace : inheritWorkspace

        // ---- 1、解析目标目录：显式 > 继承当前会话 > 插件默认 ----
        let cwd = explicitCwd || defaultCwd
        let inherited = false

        if (!explicitCwd && wantWorkspace) {
          const inheritedCwd = await resolveCallerCwd(ctx, exec)
          if (inheritedCwd) {
            cwd = inheritedCwd
            inherited = true
          }
        }

        // ---- 2、解析工作区：让新会话落进同一个分组 ----
        let workspaceId
        let workspaceTitle
        if (wantWorkspace && cwd) {
          const resolved = await resolveWorkspace(ctx, cwd)
          workspaceId = resolved?.id
          workspaceTitle = resolved?.title
        }

        // ---- 3、创建会话 ----
        // session.create 只接受 workspaceId 或 cwd 之一：工作区已经隐含了目录。
        const request = {}
        if (workspaceId) request.workspaceId = workspaceId
        else if (cwd) request.cwd = cwd

        const created = await session.create(request)
        const sessionId = created?.sessionId
        if (!sessionId) throw new Error('创建会话失败：未返回 sessionId')

        // ---- 4、可选：设置标题（失败不阻断） ----
        if (typeof args.title === 'string' && args.title.trim()) {
          try {
            await session.rename({ sessionId, title: args.title.trim() })
          } catch {
            // 标题失败不影响主流程
          }
        }

        // ---- 5、可选：发送开场提示词 ----
        let prompted = false
        if (prompt) {
          await session.prompt(
            {
              requestId: randomUUID(),
              sessionId,
              mode: 'queue',
              content: [{ type: 'text', text: prompt }],
            },
            detachedSignal(),
          )
          prompted = true
        }

        return {
          sessionId,
          prompted,
          cwd: cwd || undefined,
          workspace: workspaceTitle,
          inherited,
        }
      },
    }),
  )
}

/**
 * 读取调用方会话当前生效的工作目录。
 * 优先用 workingDirectory.ensure（会校验目录是否还存在），失败则回退到 get。
 */
async function resolveCallerCwd(ctx, exec) {
  const agent = exec?.agent
  if (!agent) return undefined

  const workingDirectory = ctx.get('workingDirectory')
  if (!workingDirectory) return undefined

  try {
    if (typeof workingDirectory.ensure === 'function') {
      const dir = await workingDirectory.ensure(agent, detachedSignal())
      if (dir) return dir
    }
  } catch {
    // ensure 会抛「原目录也不可用」，继续走 get
  }

  try {
    if (typeof workingDirectory.get === 'function') {
      return workingDirectory.get(agent) || undefined
    }
  } catch {
    // 忽略
  }

  return undefined
}

/**
 * 按目录解析或创建工作区，让新会话出现在同名分组下。
 * workspaceRegistry.create 对同一 canonical path 是幂等的。
 */
async function resolveWorkspace(ctx, cwd) {
  const registry = ctx.get('workspaceRegistry')
  if (!registry || typeof registry.create !== 'function') return undefined

  try {
    const workspace = await registry.create(cwd)
    if (workspace?.id) return { id: workspace.id, title: workspace.title }
  } catch {
    // 目录不可用 / 无权限时退化为未分组
  }

  return undefined
}

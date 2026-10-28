/**
 * Session Launcher — 新建 Harness 会话，自动继承工作区并塞入开场提示词。
 *
 * 用途：长任务上下文快满时，由当前 Agent 主动开一个新会话，
 * 新会话自动落在同一个工作区（分组 + 目录），开场白一次性发进去。
 *
 * 依赖 Host Service：
 *   - tools              注册 Tool
 *   - sessionController  创建会话 / 重命名 / 发送 prompt
 *   - workingDirectory   读取当前会话的生效目录（继承用，可选）
 *   - workspaceRegistry  解析 / 创建工作区（分组用，可选）
 *   - agentPresets       读取调用方的 agent preset（继承用，可选）
 */

import { randomUUID } from 'node:crypto'

export const name = 'session-launcher'

// 只声明硬依赖；workingDirectory / workspaceRegistry / agentPresets 通过 ctx.get() 可选获取。
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
  const inheritPreset = config.inheritPreset !== false

  ctx.effect(() =>
    ctx.tools.register({
      name: 'new_session',
      description:
        'Create a new Harness session (a fresh context window) and optionally send an opening prompt into it. ' +
        'By default the new session inherits the caller\'s working directory, workspace group, AND agent preset, ' +
        'so it appears next to this conversation in the sidebar and keeps the same tools. ' +
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
          agentPreset: {
            type: 'string',
            description:
              'Agent preset for the new session. Omit to inherit the caller\'s preset (recommended: a handoff ' +
              'that loses the preset also loses its extra tools and skills). Pass "" to force the deployment default.',
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
            preset: { type: 'string' },
            inherited: { type: 'boolean' },
            promptError: { type: 'string' },
          },
          required: ['sessionId', 'prompted', 'inherited'],
          additionalProperties: false,
        },
        render(_args, value) {
          const lines = [
            `已创建新会话：${value.sessionId}`,
            value.prompted
              ? '开场提示词已发送，新会话已开始运行。'
              : value.promptError
                ? `新会话已创建，但开场提示词发送失败：${value.promptError}`
                : '未发送开场提示词，新会话为空。',
            value.cwd
              ? `工作目录：${value.cwd}${value.inherited ? '（继承自当前会话）' : '（显式指定）'}`
              : '',
            value.workspace ? `工作区：${value.workspace}` : '工作区：未分组',
            value.preset ? `Agent 预设：${value.preset}` : '',
            value.promptError
              ? '会话已保留，可切过去手动补一句开场白——不要重新调用本工具，否则会多出一个空会话。'
              : '',
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

        if (!explicitCwd) {
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

        // ---- 3、解析 agent preset：不继承就会丢掉调用方的额外工具与技能 ----
        const preset = resolvePreset(ctx, exec, args.agentPreset, inheritPreset)

        // ---- 4、创建会话 ----
        // session.create 只接受 workspaceId 或 cwd 之一：工作区已经隐含了目录。
        const request = {}
        if (workspaceId) request.workspaceId = workspaceId
        else if (cwd) request.cwd = cwd
        // 空串表示「明确要部署默认」，不能传给 create（会被当成未知名）
        if (preset) request.agentPreset = preset

        const created = await session.create(request)
        const sessionId = created?.sessionId
        if (!sessionId) throw new Error('创建会话失败：未返回 sessionId')

        // ---- 5、可选：设置标题（失败不阻断） ----
        if (typeof args.title === 'string' && args.title.trim()) {
          try {
            await session.rename({ sessionId, title: args.title.trim() })
          } catch {
            // 标题失败不影响主流程
          }
        }

        // ---- 6、可选：发送开场提示词 ----
        // 失败时**不再抛出**：会话已经建好了，抛错会让调用方丢掉 sessionId，
        // 只能重新调用本工具，结果多出一个空会话。改为把错误带回给调用方。
        let prompted = false
        let promptError
        if (prompt) {
          try {
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
          } catch (err) {
            promptError = err instanceof Error ? err.message : String(err)
          }
        }

        const presetOut = created?.agentPreset || preset || undefined

        return {
          sessionId,
          prompted,
          cwd: cwd || undefined,
          workspace: workspaceTitle,
          preset: presetOut,
          inherited,
          promptError,
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

/**
 * 决定新会话用哪个 agent preset。
 *
 * 为什么这一条重要：agent preset 决定工具集、系统提示词和技能目录。
 * 交接时如果新会话退回部署默认 preset，调用方原有的工具就没了，
 * 表现为「新窗口里做不了刚才能做的事」，而且不会报错。
 *
 * 优先级：显式传参  >  继承调用方  >  不指定（走部署默认）
 * 传空串表示「明确不要继承」，返回 undefined 让 create 用部署默认。
 */
function resolvePreset(ctx, exec, explicit, allowInherit) {
  if (typeof explicit === 'string') {
    const trimmed = explicit.trim()
    if (trimmed === '') return undefined // 显式要求部署默认
    return trimmed
  }

  if (!allowInherit) return undefined

  const agent = exec?.agent
  if (!agent) return undefined

  const presets = ctx.get('agentPresets')
  if (!presets) return undefined

  try {
    if (typeof presets.composedPreset === 'function') {
      const id = presets.composedPreset(agent.ctx)
      if (id) return id
    }
  } catch {
    // 拿不到就退回部署默认
  }

  return undefined
}

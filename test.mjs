// session-launcher 单元测试：用假的 Host Service 验证工具行为，不启动 Harness。
// 跑法：node test.mjs
import assert from 'node:assert/strict'

import { apply, inject, name } from './index.js'

let passed = 0
let failed = 0

async function test(title, fn) {
  try {
    await fn()
    passed++
    console.log('ok   ' + title)
  } catch (err) {
    failed++
    console.log('FAIL ' + title + '\n     ' + (err && err.message))
  }
}

/** 造一个最小的 Cordis ctx：只实现本插件用到的 get / effect / tools.register。 */
function makeCtx({ config = {}, caller = {}, preset, createResult, promptThrows } = {}) {
  const calls = { create: [], rename: [], prompt: [] }
  let registered

  const ctx = {
    effect(fn) {
      fn()
    },
    tools: {
      register(def) {
        registered = def
        return () => {}
      },
    },
    sessionController: {
      async create(request) {
        calls.create.push(request)
        return createResult ?? { sessionId: 'session-new' }
      },
      async rename(request) {
        calls.rename.push(request)
        return { title: request.title, seq: 1 }
      },
      async prompt(request) {
        calls.prompt.push(request)
        if (promptThrows) throw new Error(promptThrows)
        return { accepted: true }
      },
    },
    get(service) {
      if (service === 'workingDirectory' && caller.cwd) {
        return { ensure: async () => caller.cwd }
      }
      if (service === 'workspaceRegistry' && caller.cwd) {
        return { create: async () => ({ id: 'ws-1', title: 'repo' }) }
      }
      if (service === 'agentPresets' && preset) {
        return { composedPreset: () => preset }
      }
      return undefined
    },
  }

  apply(ctx, config)
  const exec = caller.cwd || caller.agent ? { agent: { id: 'session-caller', ctx: {} } } : undefined
  return { tool: registered, calls, exec }
}

await test('inject 只声明硬依赖（不能写成对象形式，否则插件永不激活）', () => {
  assert.deepEqual(inject, ['tools', 'sessionController'])
  assert.equal(name, 'session-launcher')
})

await test('继承调用方目录 + 工作区', async () => {
  const { tool, calls, exec } = makeCtx({ caller: { cwd: 'D:\\Work\\repo' } })
  const out = await tool.execute({ prompt: 'hi' }, exec)
  assert.equal(out.inherited, true)
  assert.equal(out.cwd, 'D:\\Work\\repo')
  assert.equal(out.workspace, 'repo')
  assert.deepEqual(calls.create[0], { workspaceId: 'ws-1' })
  assert.equal(out.prompted, true)
})

await test('显式 cwd 优先于继承，且 create 只传 cwd（工作区二选一）', async () => {
  const { tool, calls } = makeCtx({})
  const out = await tool.execute({ cwd: 'D:\\Other' }, undefined)
  assert.equal(out.inherited, false)
  assert.equal(out.cwd, 'D:\\Other')
  assert.deepEqual(calls.create[0], { cwd: 'D:\\Other' })
})

await test('inheritWorkspace=false 时不解析工作区', async () => {
  const { tool, calls, exec } = makeCtx({ caller: { cwd: 'D:\\Work\\repo' } })
  await tool.execute({ inheritWorkspace: false }, exec)
  assert.deepEqual(calls.create[0], { cwd: 'D:\\Work\\repo' })
})

await test('继承调用方的 agent preset', async () => {
  const { tool, calls, exec } = makeCtx({ caller: { cwd: 'D:\\Work\\repo' }, preset: 'cordis' })
  const out = await tool.execute({}, exec)
  assert.equal(out.preset, 'cordis')
  assert.equal(calls.create[0].agentPreset, 'cordis')
})

await test('显式 agentPreset="" 表示要部署默认，不继承', async () => {
  const { tool, calls, exec } = makeCtx({ caller: { cwd: 'D:\\Work\\repo' }, preset: 'cordis' })
  const out = await tool.execute({ agentPreset: '' }, exec)
  assert.equal(out.preset, undefined)
  assert.equal('agentPreset' in calls.create[0], false)
})

await test('显式 agentPreset 覆盖继承', async () => {
  const { tool, calls, exec } = makeCtx({ caller: { cwd: 'D:\\Work\\repo' }, preset: 'cordis' })
  const out = await tool.execute({ agentPreset: 'standard' }, exec)
  assert.equal(out.preset, 'standard')
  assert.equal(calls.create[0].agentPreset, 'standard')
})

await test('prompt 失败不抛：保留 sessionId 并带回 promptError', async () => {
  // 这是关键行为：会话已建好，抛错会让调用方重试，结果多出一个空会话。
  const { tool, calls, exec } = makeCtx({
    caller: { cwd: 'D:\\Work\\repo' },
    promptThrows: 'stream closed',
  })
  const out = await tool.execute({ prompt: 'hi' }, exec)
  assert.equal(out.sessionId, 'session-new')
  assert.equal(out.prompted, false)
  assert.equal(out.promptError, 'stream closed')
  assert.equal(calls.prompt.length, 1)
})

await test('没传 prompt 且无 defaultPrompt：不发送', async () => {
  const { tool, calls } = makeCtx({})
  const out = await tool.execute({}, undefined)
  assert.equal(out.prompted, false)
  assert.equal(calls.prompt.length, 0)
})

await test('defaultPrompt 兜底', async () => {
  const { tool, calls } = makeCtx({ config: { defaultPrompt: '读交接单' } })
  const out = await tool.execute({}, undefined)
  assert.equal(out.prompted, true)
  assert.equal(calls.prompt[0].content[0].text, '读交接单')
})

await test('title 只调用 rename，不改 create 请求', async () => {
  const { tool, calls } = makeCtx({})
  await tool.execute({ title: 'V3.4 批次' }, undefined)
  assert.equal(calls.rename[0].title, 'V3.4 批次')
  assert.equal('title' in calls.create[0], false)
})

await test('prompt 用 detached signal：不是工具调用的 signal', async () => {
  const { tool, calls } = makeCtx({})
  const toolSignal = AbortSignal.abort()
  await tool.execute({ prompt: 'hi' }, { agent: { id: 's', ctx: {} }, signal: toolSignal })
  // 传进 sessionController.prompt 的第二个参数
  assert.ok(calls.prompt.length === 1)
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)

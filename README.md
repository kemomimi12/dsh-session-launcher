# Session Launcher

> 让 Agent 自己开一个新的上下文窗口：**自动继承工作区**，并把开场提示词自动发进去。

## 解决什么问题

长任务干到一半，当前会话的上下文快满了。传统做法是：

1. 用户手动点「新建会话」
2. 手动选工作区（选错了新会话就散在「未分组」里）
3. 复制粘贴一段交接说明
4. 等新会话开始工作

**Session Launcher 把这三步合成一次工具调用**：Agent 自己创建新会话、自动落进**同一个工作区分组**、自己塞开场白、自己起跑，用户切过去就能接着干。

## 效果

```
> 用 new_session 开个新窗口继续，开场白读 12 交接单，按 P1 开始

已创建新会话：session-82a81cef-76e2-4eb0-aa4f-6aafeec0a623
开场提示词已发送，新会话已开始运行。
工作目录：D:\Work\be-log-platform（继承自当前会话）
工作区：be-log-platform
```

新会话立刻出现在左侧**同名工作区分组**里并开始运行。

## 安装

```bash
# 在 DSH 里
plugin_manager(action: "install_bundle", target: "<本仓库绝对路径>")
```

或者把它放到任意目录，用 `plugin_manager` 的 `install_bundle` 指向该目录（会创建 junction/symlink，改动即时生效）。

## 使用

注册的工具是 `new_session`：

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `prompt` | 否 | 开场提示词，**等同于用户手打**。省略则创建空会话 |
| `cwd` | 否 | 新会话的工作目录。**省略则自动继承当前会话的目录** |
| `title` | 否 | 会话标题，创建后设置 |
| `inheritWorkspace` | 否 | 是否挂到调用方的工作区分组，默认 `true` |
| `agentPreset` | 否 | 新会话的 agent preset。**省略则继承调用方的 preset**；传 `""` 表示强制用部署默认 |

返回值：

```json
{
  "sessionId": "session-...",
  "prompted": true,
  "cwd": "D:\\Work\\be-log-platform",
  "workspace": "be-log-platform",
  "preset": "cordis",
  "inherited": true
}
```

| 字段 | 说明 |
| --- | --- |
| `inherited` | `true` 表示目录是从调用方会话继承的，`false` 表示显式传入或用了插件默认值 |
| `workspace` | 新会话挂上的工作区分组名，未分组时省略 |
| `preset` | 新会话用的 agent preset，未绑定时省略 |
| `promptError` | 开场提示词发送失败时的原因；此时 `prompted=false`，但 `sessionId` **仍然有效** |

### 工作区继承的优先级

```
显式 cwd  >  继承当前会话目录  >  插件配置的 cwd
```

**什么时候要显式传 `cwd`**：继续的工作属于**另一个项目**时。比如让 Agent 从 `be-log-platform` 开一个新窗口去改 Obsidian 笔记：

```
new_session(prompt: "...", cwd: "D:\\Obsidian\\Xfufu")
```

此时新会话会挂到 `Xfufu` 那个工作区分组下，而不是当前的分组。

## 配置（可选）

在 bundle patch 里给默认值，调用时可省略参数：

```yaml
- insert:
    - id: session-launcher
      name: 'dsh-session-launcher'
      config:
        cwd: "D:\\Work\\be-log-platform"
        defaultPrompt: "读交接单，按 P1 开始"
        inheritWorkspace: true
```

| 字段 | 说明 |
| --- | --- |
| `cwd` | 兜底工作目录（既没传参、也继承不到时使用） |
| `defaultPrompt` | 未传 `prompt` 时使用的开场提示词 |
| `inheritWorkspace` | 全局关闭工作区继承（默认 `true`） |
| `inheritPreset` | 全局关闭 agent preset 继承（默认 `true`）。**不建议关**，见「限制 5」的姊妹条目 |

## ⚠️ 五个必须知道的限制

### 1. 新会话立刻开始运行，你没法先审

`prompt` 一提交，新会话的 Agent 就开始消耗 token 干活。**如果开场白写错，它已经开始跑错方向了。**

**建议**：把常用的交接指令固化到文件里，调用时只引用路径：

```
prompt: "读 D:\\Obsidian\\...\\12 交接单.md，按 P1 开始写代码。"
```

### 2. 本工具无法观察新会话的后续状态

`new_session` 返回后，调用方就拿不到新会话的任何进展了。这是设计使然——新会话是独立 Agent，不是子代理。

**要看进度，只能切过去看。**

### 3. `prompt` 的 `signal` 不能复用工具调用的 signal

`sessionController.prompt(request, signal)` 的第二个参数是必填的 `AbortSignal`。

**不能用 `exec.signal`**：工具调用一结束，那个 signal 会被 abort，把刚提交的 prompt 一起取消掉，新会话收到空消息。

本插件传一个永不过期的 signal：

```js
function detachedSignal() {
  return new AbortController().signal
}
await session.prompt({ ... }, detachedSignal())
```

### 4. `session.create` 不能同时传 `workspaceId` 和 `cwd`

```
Error: session.create accepts workspaceId or cwd, not both
```

**原因**：工作区已经隐含了目录，两个一起传是矛盾的。

```js
// ✅ 二选一，工作区优先
if (workspaceId) request.workspaceId = workspaceId
else if (cwd) request.cwd = cwd
```

### 5. prompt 失败时不抛错，而是把错误带回给调用方

`v1.2.0` 改的。理由：会话**已经建好**了。如果抛错，调用方拿不到 `sessionId`，只能重新调用一次 `new_session`——结果多出一个空会话，用户要去手动删。

现在的行为：

```json
{ "sessionId": "session-...", "prompted": false, "promptError": "stream closed" }
```

渲染出来的提示会明确说「会话已保留，可切过去手动补一句开场白——不要重新调用本工具」。

## 版本变更

| 版本 | 改了什么 | 为什么 |
| --- | --- | --- |
| `1.2.0` | ① 新增 `agentPreset` 参数，默认**继承调用方的 preset** ② prompt 失败不再抛错，改为返回 `promptError` ③ 新增 `test.mjs`（12 个用例） | ① preset 决定工具集和技能目录，交接时丢了 preset 表现为「新窗口做不了刚才能做的事」且**不报错** ② 抛错会让调用方重试，产生多余空会话 |
| `1.1.0` | 包名改为 `dsh-session-launcher`；新增工作区继承 | 与仓库名对齐；避免新会话散落在「未分组」 |
| `1.0.0` | 首版 | — |

## 测试

```bash
node test.mjs     # 12 个用例，用假的 Host Service，不启动 Harness
```

覆盖：目录继承、工作区解析、preset 继承与覆盖、`inheritWorkspace: false`、prompt 失败降级、`defaultPrompt` 兜底、`title` 不影响 create 请求。

## 工作原理

```
new_session(prompt, cwd, title, inheritWorkspace, agentPreset)
  │
  ├─ workingDirectory.ensure(agent)          → 继承调用方目录（可选服务）
  ├─ workspaceRegistry.create(cwd)           → 解析/创建工作区（幂等）
  ├─ agentPresets.composedPreset(agent.ctx)  → 继承调用方 preset（可选服务）
  │
  ├─ sessionController.create({ workspaceId } | { cwd }, agentPreset?)
  ├─ sessionController.rename({ sessionId, title })        （可选，失败不阻断）
  └─ sessionController.prompt({ ... }, detachedSignal())   → 新会话开始运行（失败降级为 promptError）
```

依赖的 Host Service：

| Service | 类型 | 用途 |
| --- | --- | --- |
| `tools` | **必需** | 注册 `new_session` 工具 |
| `sessionController` | **必需** | `create` / `rename` / `prompt` |
| `workingDirectory` | 可选 | `ensure(agent)` 读取调用方目录 |
| `workspaceRegistry` | 可选 | `create(path)` 解析工作区 |
| `agentPresets` | 可选 | `composedPreset(ctx)` 继承 preset |

> **可选服务怎么声明**：`export const inject` **只能写数组**（只放硬依赖）。可选服务用 `ctx.get('name')` 拿，拿不到就降级。
>
> 写成对象形式 `{ required: [...], optional: [...] }` 会让插件卡在
> `pending (waiting for services: required, optional)` 永不激活。

## 与其他方案的区别

| 方式 | 上下文 | 你能看到过程吗 | 能自动开始吗 | 自动继承工作区 |
| --- | --- | --- | --- | --- |
| **本插件** `new_session` | ✅ 全新 | ✅ 切过去就能看 | ✅ 自动发 prompt | ✅ |
| `subagent` | ✅ 独立 | ❌ 只看最终结果 | ✅ 但过程是黑盒 | ✅ |
| `subagent_fork` | ✅ 继承本对话 | ❌ 同上 | ✅ 同上 | ✅ |
| 手动点「新建」 | ✅ 全新 | ✅ | ❌ 要手打提示词 | ❌ 要手动选 |

**什么时候用哪个**：

- 需要**你审核每一步** → 本插件（新会话是正常会话，你能随时插话）
- 需要**并行跑一堆独立小任务** → `subagent`
- 需要**基于本对话继续** → `subagent_fork`

## 兼容性

- 依赖 DSH 的 `sessionController`（`@deepseek-ai/dsh-session`）
- `workingDirectory` / `workspaceRegistry` 缺失时自动降级：目录继承失效，新会话落「未分组」
- 纯 Host 插件，无 UI、无构建步骤、无外部依赖
- 只需 `node:crypto` 的 `randomUUID`

## License

MIT

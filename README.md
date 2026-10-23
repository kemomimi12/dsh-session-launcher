# Session Launcher

> 让 Agent 自己开一个新的上下文窗口，并把开场提示词自动发进去。

## 解决什么问题

长任务干到一半，当前会话的上下文快满了。传统做法是：

1. 用户手动点「新建会话」
2. 复制粘贴一段交接说明
3. 等新会话开始工作

**Session Launcher 把这三步合成一次工具调用**：Agent 自己创建新会话、自己塞开场白、自己起跑，用户切过去就能接着干。

## 效果

```
> 用 new_session 开个新窗口继续，开场白读 12 交接单，按 P1 开始

已创建新会话：session-ca489836-b22e-4950-81a8-9c95fdc9a309
开场提示词已发送，新会话已开始运行。
工作目录：D:\Work\be-log-platform
```

新会话立刻出现在左侧列表并开始运行。

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
| `cwd` | 否 | 新会话的工作目录。省略则用插件配置，再省略则继承当前会话 |
| `title` | 否 | 会话标题，创建后设置 |

返回值：

```json
{
  "sessionId": "session-...",
  "prompted": true,
  "cwd": "D:\\Work\\be-log-platform"
}
```

## 配置（可选）

在 bundle patch 里给默认值，调用时可省略参数：

```yaml
- insert:
    - id: session-launcher
      name: '@local/session-launcher'
      config:
        cwd: "D:\\Work\\be-log-platform"
        defaultPrompt: "读交接单，按 P1 开始"
```

| 字段 | 说明 |
| --- | --- |
| `cwd` | 默认工作目录 |
| `defaultPrompt` | 未传 `prompt` 时使用的开场提示词 |

## ⚠️ 三个必须知道的限制

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
const signal = new AbortController().signal
await session.prompt({ ... }, signal)
```

> 这个坑实测踩过：第一次实现没传 signal，报 `Cannot read properties of undefined (reading 'throwIfAborted')`。

## 工作原理

```
new_session(prompt, cwd, title)
  │
  ├─ sessionController.create({ cwd })       → sessionId
  ├─ sessionController.rename({ sessionId, title })   （可选，失败不阻断）
  └─ sessionController.prompt({
       requestId: randomUUID(),
       sessionId,
       mode: 'queue',
       content: [{ type: 'text', text: prompt }],
     }, signal)                              → 新会话开始运行
```

依赖两个 Host Service：

| Service | 用途 |
| --- | --- |
| `tools` | 注册 `new_session` 工具 |
| `sessionController` | `create` / `rename` / `prompt` |

## 与其他方案的区别

| 方式 | 上下文 | 你能看到过程吗 | 能自动开始吗 |
| --- | --- | --- | --- |
| **本插件** `new_session` | ✅ 全新 | ✅ 切过去就能看 | ✅ 自动发 prompt |
| `subagent` | ✅ 独立 | ❌ 只看最终结果 | ✅ 但过程是黑盒 |
| `subagent_fork` | ✅ 继承本对话 | ❌ 同上 | ✅ 同上 |
| 手动点「新建」 | ✅ 全新 | ✅ | ❌ 要手打提示词 |

**什么时候用哪个**：

- 需要**你审核每一步** → 本插件（新会话是正常会话，你能随时插话）
- 需要**并行跑一堆独立小任务** → `subagent`
- 需要**基于本对话继续** → `subagent_fork`

## 兼容性

- 依赖 DSH 的 `sessionController` 服务（`@deepseek-ai/dsh-session`）
- 纯 Host 插件，无 UI、无构建步骤、无外部依赖
- 只需 `node:crypto` 的 `randomUUID`

## License

MIT

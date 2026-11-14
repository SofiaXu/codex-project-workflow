# Agent 接入

## 配置与选择

优先级：`review --config PATH` → 项目 `.codex/adversarial-acceptance/agent.json` → 本 Skill 的 `config.local.json` → 自动发现。一次选择后遇到错误不静默换供应商。`--model`、`--timeout-ms` 覆盖配置，默认超时为 600000 毫秒。

配置按版本 1 读取，只接受接入字段，不接受任意提示词、总结或环境变量值。相对 command 和以 `./` 或 `../` 开始的参数路径按配置文件目录解析。Windows 的 `.cmd/.bat/.ps1` 用显式原生解释器及参数数组调用；不拼接 shell 命令。

```json
{
  "version": 1,
  "adapter": "deepseek",
  "transport": "acp",
  "command": "dsh",
  "args": [],
  "envAllowlist": ["DEEPSEEK_API_KEY", "HTTPS_PROXY"],
  "timeoutMs": 600000
}
```

上述 command 适用于原生 dsh 可执行文件；自动发现另外支持 npm 的 Windows dsh shim 和默认安装位置的 DeepSeek 桌面运行时。其他安装路径通过配置指定原生解释器及 CLI 入口。`credentialsFile` 可引用其他既有 DeepSeek 凭据文件；不复制或打印凭据。`provider` 与 `model` 同时指定时设置初始 DeepSeek 路由；仅 `model` 则使用实时 ACP 目录中的完整不透明 ID。

个人路径、认证变量名称及自定义脚本可以保存在本地配置和同目录文件中；公开配置保持可移植，实际凭据留在已有存储。仓库忽略 Skill 的 `config.local.json` 和 `local/`，全局更新必须保留它们。项目级配置是否提交由目标项目决定。

## 内置 DeepSeek 适配器

自动发现优先 PATH，其次默认 Windows 桌面安装。原生 CLI 或桌面安装不可用时，查询 npm 官方包 `@deepseek-ai/dsh` 的 `latest`，将返回的确切版本用于临时 `npm exec`，不覆盖已有安装。

安装路径保留当前模型：桌面运行时只读取其 `agent-default-model` 行的 provider/model；原生 ACP 读取其已保存 ACP 选择，否则沿用新建会话的当前模型。不会加载完整用户 patch、Skill、会话或记忆。当前模型指接入适配器可读取的保存选择/ACP 当前值，不推测其他界面的临时未保存选择。

只有默认下载路径需要解析最新模型：从 [DeepSeek 官方模型表](https://api-docs.deepseek.com/quick_start/pricing/) 读取版本顺序，再与 ACP 实时可用目录核对。表结构不明确、最新模型不可用或候选不唯一时报错；不按不透明 ACP ID 排序，也不降级到旧模型。报告保存解析来源与实际模型 ID。

每次使用独立临时 DSH_HOME 和默认 ACP profile，仅通过 credentials.path 引用既有认证。禁用仓库指令、Skill 发现和辅助标题模型；载入 [dsh-guard.mjs](../scripts/dsh-guard.mjs)，以空允许列表移除工具、以单调 guard 拒绝执行，并覆盖完整系统提示。请求前须收到带本次 nonce 的隔离确认；任何工具 schema、调用或权限请求均失败。

guard 同时抑制可选动态上下文，以阻断记忆提供者；必需上下文仅允许 `working-directory:current`，未知上下文在发起模型请求前报错。`npm run test:profile` 使用真实 DSH 引擎与回环 Messages 服务，主动加载带标记的记忆/指令提供者，检查模型实际收到的请求不含标记、工具为空，并验证未知必需上下文会在推理前被拒绝。此项使用构造的测试密钥与本地响应，不访问真实模型。

参考：[DeepSeek CLI](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/README.md)、[ACP 服务契约](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/README.md)、[工具限制](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/tools/README.md)。最新版适配不兼容时明确失败，不能跳过 guard 继续调用。

## 其他 ACP Agent 与调用脚本

`adapter: "custom"` 支持 `transport: "acp"` 或 `"command"`，并要求：

```json
{
  "isolation": {
    "toolsDisabled": true,
    "instructionsDisabled": true,
    "memoryDisabled": true
  }
}
```

这些字段声明用户选择的启动器承担隔离责任，不是脚本能审计所有第三方进程的证明。启动脚本须实际关闭 Agent 原生工具、自动规则读取和记忆，并在准备好后向 stderr 写一行：

```text
{"acceptanceGuard":1,"nonce":"本次 ACCEPTANCE_GUARD_NONCE 环境变量","tools":0,"instructions":false,"memory":false}
```

ACP 在新会话创建完成后、发送包含证据的 prompt 前验证该确认；command 也须先独立输出隔离确认，主进程确认后才向 stdin 写证据。创建 ACP 会话须给出真实 Agent name/version 和 model 配置项。客户端协商稳定 v1，不暴露文件系统、终端或 MCP，拒绝权限请求；直接请求禁用能力或发送工具通知都使本轮失败。所有调用使用全新 session，不恢复已有实现会话。

command 启动器从 stdin 接收一个 JSON 对象 `{ "version": 1, "prompt": "固定指令与冻结证据" }`，向 stdout 返回 `{ "agent": { "name": "实际Agent", "version": "实际版本", "model": "实际模型" }, "response": { ...评审JSON... } }`；诊断只写 stderr。它须将原始 prompt 直接交给独立 Agent，不能合成裁决或接收实现者解释。退出非零、缺少隔离确认或缺少身份信息均为 ERROR。

启动器和自带的系统配置属于受信接入代码；ACP、空目录和环境白名单均不等于操作系统沙箱。未提供并验证隔离适配器的其他已安装 CLI 不自动作为可用评审 Agent。

环境默认仅保留运行必需的 PATH、Windows 系统变量及语言/时区设置，HOME、用户目录和临时目录指向隔离位置。额外认证/代理变量由 envAllowlist 按名称显式放行；内置 DeepSeek 额外支持 DEEPSEEK_API_KEY/DEEPSEEK_BASE_URL。不继承 NODE_OPTIONS 等启动注入变量。退出、超时或取消后关闭会话/连接并回收本次进程与临时目录，原始响应留在指定产物目录。

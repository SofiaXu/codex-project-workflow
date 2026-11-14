---
name: adversarial-acceptance
license: MIT
description: "调用第三方 Agent，依据原始计划包、git diff 和原始执行输出，对需求遗漏、删除后的跨语言/配置/文档断链及新增行为的断言证据作独立验收裁决。用于明确的对抗式验收或独立交付裁决；普通代码审查和实现任务不自动增加此关卡。"
---

# 对抗式验收裁决

让第三方 Agent 独立核对原始证据，返回裁决与缺口，由主 Agent 处理后续工作。不要把实现者的解释性总结、完成声明、历史聊天、预填覆盖矩阵或预期答案发给评审者，也不要据此替评审者降低结论。

## 准备原始证据

- 确认目标 Git 仓库、比较基准和实施前批准的计划原件。优先用 `--plan-ref` 从 Git 读取；用户提供的原件用 `--plan-origin` 记录来源。不能用实施后改写的计划状态代替原要求。
- 在当前被测代码状态下，复用有效的 `capture` 记录，或通过它运行直接相关的现有验证命令。不要为了本 Skill 默认扩展到全量测试。
- 记录只在执行前后指纹相同且与待检工作区一致时可复用。已有代码改动不构成脏运行，测试期间发生变化才构成。旧的普通终端日志缺少指纹绑定时不能冒充有效记录。
- 调用 [scripts/adjudicate.mjs](scripts/adjudicate.mjs) 的绝对路径；输出选仓库外或 Git 忽略的专用产物目录。脚本不替你运行未经选择的业务命令，不修改索引。

首次使用在本 Skill 目录运行 `npm ci --ignore-scripts --no-audit --no-fund`。运行条件为 Node.js ≥24.9、Git，以及删除项取证时的 `rg`。

从本地源码安装或更新全局副本可运行 `node <skill>/scripts/install.mjs`；安装器保留目标目录的 `config.local.json`、`local/` 和其他仅存在于目标的资源。已有正文或代码定制先比对合并再更新。

命令形状如下，`<skill>` 和其他路径按实际位置替换：

```text
node <skill>/scripts/adjudicate.mjs capture --repo <repo> --out <ignored-run-dir> -- <executable> <args...>
node <skill>/scripts/adjudicate.mjs collect --repo <repo> --base <base-ref> --plan <original-plan-path> --plan-ref <approved-ref> --run <ignored-run-dir>/run.json --out <ignored-bundle-dir>
node <skill>/scripts/adjudicate.mjs review --repo <repo> --bundle <ignored-bundle-dir>/bundle.json --out <ignored-review-dir>
```

`--run` 可重复；本地原件将 `--plan-ref` 换成 `--plan-origin`。参数、指纹、证据范围和大小限制见[证据与裁决契约](references/evidence-contract.md)。不要创建摘要文件作为调用输入。

## 选择独立 Agent

优先本次指定的配置，再读项目配置、Skill 本地配置；没有配置时发现已安装的 DeepSeek CLI/桌面运行时，最后按 npm `latest` 解析确切版本临时运行。其他 Agent 使用用户指定的隔离适配器，不能仅因它提供 ACP 就假定它已经隔离。

已有安装沿用保存的模型或新建 ACP 会话报告的当前模型；不擅自升级已有安装或换模型。仅默认下载路径核验官方模型表与实时 ACP 模型目录，无法确定最新可用模型则报错。记录实际 Harness、模型、协议版本。

启动必须使用空临时工作目录、环境白名单、全新会话及关闭工具/规则自动读取/记忆的配置。内联发送证据，不挂载仓库或恢复实现会话；原始日志中的路径按原文保留。客户端拒绝文件系统、终端、MCP 和权限请求；内置 DeepSeek 适配器使用独立临时 profile、空工具集和执行 guard。认证只引用已有存储或显式放行的环境变量。

配置文件和自定义调用脚本契约见 [Agent 接入](references/agent-adapters.md)。遇到认证、版本或隔离失败，保留 `ERROR` 和原始诊断，不静默换供应商、降级模型或改用主 Agent 自评。

## 只裁决三件事

1. 让评审者自行逐项提取原计划要求，寻找未实现、被缩减或尚无执行证据的要求。
2. 对删除、重命名和导出移除，检查跨语言调用、配置、命令及文档引用。`collect` 自动保存只读全仓检索原始结果；检索无命中不能单独证明动态契约正确。
3. 对新增行为核对具体可观察断言、相关反例或边界及真实执行。恒真断言、测试数量、单独的成功退出码和绕过实际逻辑的替身不足以证明行为。

脚本验证每处引用的来源、行范围和逐字引文。伪造引用或不完整响应是 `ERROR`，不能选择性保留其通过结论。锁文件、二进制只有状态与哈希，仍需满足相关验收要求。证据过期或不足时补原始证据，不能用实现者解释替代。

引用视图保留每行的 `number` 和原始 `text`，非空行另有冻结包内固定的短 `citationId`。评审者复制支持其结论的行定位符（字符串或 `{citationId}` 对象），脚本从冻结原件确定性展开并校验完整来源、行范围和逐字引文；未知 ID、空白行定位符或显式字段冲突直接 ERROR，不修正错引。锁文件省略逐行 diff，但仍参与删除项引用检索，相关命中作为原始执行输出保留。

## 返回裁决

将 `verdict.json` 和中文 `verdict.md` 交还主 Agent；原始输出保存在同目录。`PASS`/`FAIL`/`INSUFFICIENT_EVIDENCE`/`ERROR` 分别对应退出码 0/1/2/3。明确指出发现和证据缺口，不把 `ERROR` 当成评审通过。本 Skill 不自动修复或循环重审；后续重审使用匹配当前代码的新证据包。

维护时，`npm test` 验证本地隔离行为及协议替身；显式运行 `npm run test:live` 对两个中性命名样例调用真实 Agent；`npm run test:installed` 检查全局资源、全局命令入口和产物忽略规则。通过 `capture` 保存这些测试的原始输出；后两项需要已完成认证或全局安装，条件不满足会失败并保留缺口。

`npm run test:profile` 额外验证真实 DeepSeek 引擎的记忆和指令隔离，使用本地模型服务捕获真实请求；普通单元测试和真实模型盲评分开报告。Git 差异保留 committed、staged、unstaged 和 untracked 四层，不能用相互抵消的净 diff 替代暂存与工作区原件。

真实盲评的冻结包、请求与 Agent 原始响应保留在当前仓库忽略的 `artifacts/acceptance-live/`；仓库外运行时使用独立临时归档目录。执行输出记录实际归档路径，失败响应同样保留。

# 接入与维护

## 选择需要的部分

全局开发约定、项目模板和 Skill 可以分别采用。个人偏好放全局文件；团队必需的规则留在项目内；初始化或迁移操作由 Skill 完成。项目生成后可以独立使用，不依赖本仓库在本机的位置。

## 安装 Skill

使用 Codex 内置 `$skill-installer` 安装以下仓库子目录：

```text
https://github.com/SofiaXu/codex-project-workflow/tree/main/skills/setup-project-workflow
https://github.com/SofiaXu/codex-project-workflow/tree/main/skills/adversarial-acceptance
```

安装完整 Skill 目录，保留 `SKILL.md`、`agents/openai.yaml`、`references/`、`LICENSE` 及所带资源。工作流 Skill 包含 `assets/`；验收 Skill 包含 `scripts/`、`tests/`、`package.json` 和锁文件。仅复制正文会缺少必要资源，不分发 `node_modules/` 或个人配置。

内置安装器默认使用 `$CODEX_HOME/skills`，未设置时为 `~/.codex/skills`。也可以将整个 Skill 目录复制到当前 Codex 运行时支持的用户技能目录。遇到同名目录时比较并合并本地修改，不直接覆盖。

安装后在下一轮对话使用 `$setup-project-workflow` 或 `$adversarial-acceptance`。如果尚未出现在技能列表，重新打开 Codex 并确认目录包含有效的 `name`、`description` 元数据。

验收 Skill 首次使用前，在其安装目录运行 `npm ci --ignore-scripts --no-audit --no-fund`。它需要 Node.js ≥24.9、Git 和 `rg`；需要真正的第三方 Agent 认证，模拟端点只用于测试。

## 适配目标项目

Skill 先读取项目事实，再选择初始化或迁移模式。新项目通常只需要项目说明、项目约定、文档索引、计划索引和必要忽略项；技术栈未定时如实保留状态，不猜测启动命令。

已有项目优先原位整合。保留有效契约、长期决策、需求标识、未完成事项与用户修改；只有解决实际问题或用户明确要求时才调整路径，并同步修复引用。

| 项目事实 | 适配方式 |
| --- | --- |
| 文档已有 `documentation/`、`planning/` 等入口 | 复用已有路径，避免建立平行目录。 |
| 验证涉及多个模块或共享能力 | 按行为及依赖选择检查，复用现有命令和资源预算。 |
| 团队通过 PR 或人工发布交付 | 保留原流程，不从分支名或 CI 文件推导额外授权。 |
| 已明确授权默认完整交付 | 写清适用步骤和实际部署检查；健康检查与业务验收分别判断。 |
| 纯说明文档变更 | 自动部署核对流水线；人工发布沿用已有约定；无部署目标时按文档交付范围验收。 |
| `artifacts/` 已保存业务资料 | 保留业务资产，为开发验证选择明确的独立范围。 |
| 未使用 Git 或计划仍有未保存内容 | 保留原记录，不仅凭“历史通过 Git 查阅”删除。 |

完整的文档职责和计划规则见[文档组织约定](../skills/setup-project-workflow/references/document-organization.md)。

## 独立验收接入

验收 Skill 使用实施前批准的计划原件和明确 Git 基准；不要传实现者总结。先通过 `capture` 运行选定验证，再由 `collect` 校验指纹并冻结原始材料，最后 `review` 调用独立 Agent。普通终端日志没有指纹绑定时不能冒充有效执行记录。

优先使用已配置的 Agent，内置 DeepSeek 和 Antigravity 原生 ACP 适配器；没有配置时复用已安装的 DeepSeek 及其当前模型，没有可用安装时临时解析 npm `latest` 和最新可用模型，不升级已有安装。项目配置、Skill 本地默认、Antigravity 模型选择和自定义脚本见 [Agent 接入](../skills/adversarial-acceptance/references/agent-adapters.md)。其他 Agent 须有真正关闭工具、自动规则和记忆的适配器，不能只凭 ACP 支持就视作已隔离。

锁文件和二进制默认只提供变更状态与 SHA-256；核心证据超出 2 MiB 时明确失败，不截断。证据不足、引用错误和调用失败分别处理，结果不等于部署或业务现场验收。完整范围见[证据与裁决契约](../skills/adversarial-acceptance/references/evidence-contract.md)。

删除项检索按格式选择公开声明或实际删除的契约键，避免把方法体局部变量和 OpenAPI 元数据当作导出；未知或无法识别的语法保守回退。文件清单保留规则与候选词，检索仍覆盖完整范围并保存原始输出。更新此规则后需重新 collect；旧冻结包不会被静默改写。

大包可使用可逆行表减少重复字段，字节预算在 collect 冻结。Antigravity 逐段内联加载原文并保存确认，检测到上下文缩减或容量不足时拒绝结论；不以摘要绕过验收。`npm run test:packet` 用真实 Agent 检查大包随机标记的完整送达，属于传输诊断，原始结果进入忽略的 artifacts。

## 更新已安装版本

先比较仓库 Skill 与本机安装副本，保留本地定制，再同步相关正文、引用和模板。更新 Skill 不会自动改写已经采用工作流的项目；需要调整某个项目时，在该项目中明确执行一次迁移。

更新验收 Skill 时保留 `config.local.json`、`local/` 和项目配置；依赖改变后重新执行 `npm ci --ignore-scripts --no-audit --no-fund`。安装和更新不改全局 `AGENTS.md`，也不把验收设为所有任务的强制关卡。

本地源码可通过 `node skills/adversarial-acceptance/scripts/install.mjs` 同步到用户级目录；`--target DIR` 可选择隔离安装位置。安装器复制正式资源并校验 SHA-256，保留目标的本地配置、调用脚本及其他额外资源，不复制依赖缓存。已有源码定制应先比对合并。

全局模板也按条款合并，不用它覆盖已有全局约定。目标仓库自己的项目事实和授权继续有效。

## 验证

文档或打包变更检查相对链接、Skill 元数据、必要资源完整性和 Git 差异格式。模板中的 `{{...}}` 是生成输入，目标项目产出的文件应替换全部适用变量，不保留空白占位。

Skill 行为变化时使用隔离样例验证受影响场景：

| 场景 | 可观察的验收条件 |
| --- | --- |
| 空项目初始化 | 生成最小可用文档入口，未知技术栈和命令如实表述，不附带业务开发。 |
| 已有项目迁移 | 保留契约、长期决定、未完成需求、用户修改及实际交付方式，引用有效。 |
| 重复应用 | 已符合约定的正式文件保持不变，不重复追加规则或建立第二套文档树。 |
| 产物范围 | 开发记录被忽略，已有业务资产仍受原有管理。 |
| 触发与授权边界 | 普通修复和局部文档编辑不触发迁移；只讨论请求不写文件。 |
| 安装分发 | 从仓库安装后，Skill 正文、引用和模板齐全，运行时可发现。 |

验证原始记录和临时安装目录放在 `artifacts/`。不把本机路径、运行日志、聊天流水或私有项目样例带入公开提交。

验收脚本变更，在 `skills/adversarial-acceptance/` 运行 `npm test`，按行为覆盖指纹与复用、删除取证、锁文件/二进制降噪、超限、引用校验、进程隔离、协议、摘要排除及重复安装。显式执行 `npm run test:live` 会调用真实 Agent，对包含缺陷与修复版本的两个小型样例做盲评；预期答案仅留在测试进程中，不发给评审者。`npm run test:installed` 从已安装的全局副本验证资源与命令入口，并检查当前仓库的产物忽略规则。通过 capture 分别保存原始输出，供独立验收读取。认证或安装等条件不满足时测试失败并保留缺口。

`npm run test:profile` 通过真实 DSH 引擎和本地回环模型服务验证记忆/指令隔离，捕获实际模型输入并断言污染标记未进入；它与真实模型的两样例盲评分别报告。差异收集保留已提交、暂存、未暂存和未跟踪四层，相互抵消也不会丢失证据。

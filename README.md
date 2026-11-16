# Codex Project Workflow

一套可跨项目采用的 Codex 开发工作流：用全局约定表达个人偏好，用项目级 `AGENTS.md` 明确项目事实与交付边界，用 Skill 初始化文档组织或调用第三方 Agent 独立验收。

适合希望减少重复提示词，同时保留项目自主性、有效验证和完整交付的人。

## 仓库内容

| 内容 | 用途 |
| --- | --- |
| [全局 AGENTS.md](templates/global/AGENTS.md) | 复用优先、必要重构、自主推进、最小充分验证及已有修改保护。 |
| [项目 AGENTS.md 模板](skills/setup-project-workflow/assets/project-agents.md.template) | 根据目标仓库生成项目责任、文档路由、验证与交付约定。 |
| [setup-project-workflow Skill](skills/setup-project-workflow/SKILL.md) | 为新项目初始化工作流，或迁移已有项目的开发约定和文档组织。 |
| [adversarial-acceptance Skill](skills/adversarial-acceptance/SKILL.md) | 只依据原始计划、git diff 和执行输出，独立裁决需求遗漏、删除断链与断言证据缺口。 |
| [文档组织约定](skills/setup-project-workflow/references/document-organization.md) | 正式文档、待交付计划、验证产物和通用工具的职责与生命周期。 |
| [接入与维护说明](docs/adoption.md) | 安装、适配、更新和验证方法。 |

模板和 Skill 不绑定某个项目的技术栈、主分支名称、并发进程数或部署环境。

## 快速使用

### 1. 安装用户级 Skill

在 Codex 中使用内置安装器：

```text
$skill-installer 从 https://github.com/SofiaXu/codex-project-workflow/tree/main/skills/setup-project-workflow 安装这个 Skill。
```

独立验收 Skill 可将上述路径换成 `skills/adversarial-acceptance`。两者分别安装，均需完整目录，包括正文、元数据、引用和所带模板或脚本。内置安装器使用 `$CODEX_HOME/skills`，未设置 `CODEX_HOME` 时默认使用 `~/.codex/skills`。已有同名 Skill 时先比较和合并更新，避免直接覆盖本地定制。

安装后在下一轮对话使用；如果当前界面尚未刷新，可重新打开 Codex。

### 2. 初始化或迁移目标项目

打开目标项目后，按实际需要选择一条请求。

新项目：

```text
$setup-project-workflow 初始化当前项目的开发约定和文档结构。
```

已有项目：

```text
$setup-project-workflow 迁移当前项目的开发约定和文档结构，保留已有有效内容与未完成事项。
```

只讨论方案：

```text
$setup-project-workflow 先调查当前项目并给出迁移草案，暂时不要写文件。
```

Skill 会读取项目实际情况，复用已有文档位置和规则，按任务授权写入。普通功能开发、缺陷修复和单篇文档修改不属于它的触发范围。

### 3. 按需采用全局约定

将 [全局模板](templates/global/AGENTS.md) 中适合自己的条款合并到 `$CODEX_HOME/AGENTS.md`；未设置 `CODEX_HOME` 时通常为 `~/.codex/AGENTS.md`。

全局模板与 Skill 可以分别使用。安装 Skill 不会自动更改全局约定；团队必须共同遵守的规则仍应保存在项目内。

### 4. 按原始证据独立验收

```text
$adversarial-acceptance 对照批准的原始计划，使用第三方 Agent 验收当前变更；只传原计划、git diff 和原始执行输出。
```

验收器通过 `capture` 绑定测试前后工作区指纹，`collect` 冻结证据并自动检索删除项引用，`review` 在独立进程中调用第三方 Agent 并机械校验其引用。它区分通过、发现缺陷、证据不足和调用错误，返回裁决后交还主 Agent 处理。

该 Skill 需要 Node.js ≥24.9、Git 和删除项检索用的 `rg`；首次使用在 Skill 目录运行 `npm ci --ignore-scripts --no-audit --no-fund`。优先使用已配置的 Agent，内置支持 DeepSeek 和 Antigravity ACP；未配置时复用已安装的 DeepSeek，缺少时临时取最新版。认证沿用已有存储。详细契约见[证据说明](skills/adversarial-acceptance/references/evidence-contract.md)和 [Agent 接入](skills/adversarial-acceptance/references/agent-adapters.md)。

## 工作流要点

- **复用和必要替换。** 优先沿用现有模块，允许清理本轮替代的旧实现，并处理实际调用方、契约及数据影响。
- **按行为选择验证。** 关注受影响的业务行为和依赖路径，复用现有检查；新增影响、失败修复或未解决风险才构成补充验证的理由。
- **按证据判断交付。** 实现、推送、部署健康和业务验收分别表示不同状态；外部责任应说明归属。
- **让计划保存剩余工作。** 正式文档描述当前能力，计划描述待交付差额。完成后先更新正式文档，再在证据和历史留存条件满足时结清计划。
- **适配项目交付方式。** 保留 PR、人工发布或已明确授权的自动交付方式；纯说明文档的发布处理以实际流程为准，自动部署项目需核对流水线是否支持免部署。
- **保留已有内容。** 迁移保留有效契约、历史决定、未完成需求和用户修改；重复应用只修复实际差额。

## 默认组织方式

| 位置 | 职责 |
| --- | --- |
| `README.md` | 项目用途、当前状态、启动与常用验证入口。 |
| `AGENTS.md` | 项目约束、文档路由及交付约定。 |
| `docs/README.md` | 正式文档索引。 |
| `docs/plan/README.md` | 待交付需求、依赖和计划索引。 |
| `docs/plan/YYYY-MM-DD-主题/` | 一次实际独立规划；有需求时才创建。 |
| `artifacts/` | 不入库的验证原始记录与临时产物。 |
| `scripts/` | 有实际复用价值的维护工具。 |

已有项目可以继续使用等价目录，例如 `documentation/` 或 `planning/`。只创建有实际内容的文件和目录。完整约定见[文档组织说明](skills/setup-project-workflow/references/document-organization.md)。

## 验证与维护

本仓库分发 Markdown、模板、Skill 元数据及验收调用脚本，没有业务应用或部署目标。变更后按影响检查结构、链接、模板及安装结果；初始化/迁移用隔离项目验证，验收脚本使用其 Skill 目录下的 `npm test`，真实 Agent 接入另做小型盲评。详细标准见[接入与维护说明](docs/adoption.md#验证)。

正式文档入口见[文档索引](docs/README.md)，后续工作见[需求与计划](docs/plan/README.md)。原始验证产物放在被忽略的 `artifacts/` 中。

## 参考资料

- [OpenAI：AGENTS.md 配置机制](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
- [OpenAI：构建与使用 Skills](https://learn.chatgpt.com/docs/build-skills)
- [OpenAI：重新审视 Skills 和提示词](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra)

计划生命周期和交付策略是本仓库提供的可适配约定，应结合目标项目实际情况采用。

## 许可证

本仓库采用 [MIT 许可证](LICENSE)。Skill 目录包含同一份许可声明，以便独立安装和分发时保留。

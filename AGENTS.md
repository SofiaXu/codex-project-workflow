# codex-project-workflow 开发说明

- 本仓库分发 Codex 工作流约定、文档模板和 Skill。使用与验证入口见 [README.md](README.md)，正式文档见[文档索引](docs/README.md)。
- `skills/setup-project-workflow/` 是可分发的 Skill 源码；文档组织规则以其中的 `references/document-organization.md` 为主要维护位置，使用说明通过链接引用。
- `templates/global/AGENTS.md` 是可选个人模板；它不替代目标项目自己的事实与团队约束。迁移不得复制某个项目的技术栈、主分支或部署授权。
- 按受影响行为验证 Skill 结构、引用、模板及安装路径；改变初始化或迁移行为时用隔离样例验证，重点保留已有内容并检查重复应用。不默认运行无关测试。
- 需要独立规划时在 `docs/plan/` 维护需求与验收条件，交付后更新正式文档并按[计划约定](docs/plan/README.md)结清。
- 日志、验证样例、下载检查和原始结果放在不入库的 `artifacts/`；只将有重复维护价值的工具放入 `scripts/`。公开内容保持可移植，不包含个人本机路径、凭据或其他项目的私有资料。
- Git 交付遵循当前任务授权，保留已有修改；本仓库没有应用部署目标，说明文档和 Skill 发布以对应检查、提交及推送结果验收。

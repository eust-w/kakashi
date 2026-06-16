# Security Policy

Language: 简体中文 | English

## 报告安全问题

请不要在公开 issue 中粘贴 API Key、GitHub token、Codex access token、私有仓库内容、完整漏洞利用代码或敏感日志。

如果 GitHub Security Advisory 在本仓库可用，请优先通过私有安全公告报告。否则请创建一个不包含敏感细节的 issue，说明影响范围和可联系上下文，维护者会跟进私下沟通方式。

## 密钥处理

Kakashi 依赖 GitHub 和 Codex 的本地认证。请使用以下方式管理密钥：

- `gh auth login`
- `codex login`
- CI secrets
- 临时 shell 环境变量
- 系统凭据管理器

不要把密钥写入代码、README、issue、日志、生成项目或测试夹具。

Kakashi 会在命令输出、运行状态事件、融合计划和导出报告写盘前做通用密钥脱敏。脱敏是防线之一，不应替代正确的凭据管理；不要把真实密钥放进需求文本、Codex 输出、验证日志或生成项目源码。

## English

Do not post API keys, GitHub tokens, Codex access tokens, private repository content, full exploit code, or sensitive logs in public issues.

If GitHub Security Advisories are available for this repository, use a private advisory first. Otherwise, open a minimal public issue without sensitive details and include enough context for maintainers to follow up privately.

Kakashi relies on local GitHub and Codex authentication. Use `gh auth login`, `codex login`, CI secrets, temporary shell environment variables, or a system credential manager. Do not commit secrets to code, README files, issues, logs, generated projects, or test fixtures.

Kakashi redacts common secrets before writing command output, run-state events, fusion plans, and exported reports to disk. Redaction is a defense-in-depth measure, not a substitute for correct credential handling; do not place real secrets in prompts, Codex output, verifier logs, or generated project source.

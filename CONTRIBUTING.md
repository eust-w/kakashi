# Contributing to Kakashi

Language: 简体中文 | English

Kakashi is open source under the MIT License. Issues, documentation fixes, tests, and pull requests are welcome.

## 开发流程

1. Fork 仓库并创建分支。
2. 使用 Node.js 24+ 和 pnpm 10+。
3. 运行 `pnpm install`。
4. 修改代码或文档。
5. 运行本地检查。

```bash
pnpm lint
pnpm typecheck
pnpm test:coverage
pnpm build
```

涉及 Web UI 时请运行：

```bash
pnpm test:e2e
```

涉及 GitHub 搜索、Codex 执行或验证回环时，请在 PR 中说明是否运行过真实集成测试：

```bash
RUN_REAL_INTEGRATION=1 pnpm test:integration
RUN_CODEX_INTEGRATION=1 pnpm test:codex
```

## Pull Request 要求

- 不要提交 API Key、GitHub token、Codex access token、日志中的密钥或生成项目中的私密文件。
- 不要用 mock、仿真或硬编码成功路径替代核心 GitHub/Codex/Verifier 行为。
- 新增行为应有对应测试；影响 CLI 或 Web UI 的改动应说明验证命令。
- 许可证相关改动需要说明来源仓库、SPDX 许可证和使用边界。

## English

Use Node.js 24+ and pnpm 10+. Run `pnpm lint`, `pnpm typecheck`, `pnpm test:coverage`, and `pnpm build` before opening a pull request. Run `pnpm test:e2e` for Web UI changes. For GitHub search, Codex execution, or verifier-loop changes, mention whether you ran the real integration tests.

Never commit API keys, GitHub tokens, Codex access tokens, secret-bearing logs, or private generated project files. Core GitHub, Codex, and verifier behavior should not be replaced with mocks, simulations, or hardcoded success paths.

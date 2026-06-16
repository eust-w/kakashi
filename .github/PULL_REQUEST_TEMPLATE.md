## Summary

Describe the change and why it is needed.

## Verification

List the commands you ran.

- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm test:coverage`
- [ ] `pnpm build`
- [ ] `pnpm test:e2e` if the Web UI changed
- [ ] Real GitHub/Codex integration tests if the search, execution, or verifier loop changed

## Safety

- [ ] No API keys, tokens, private repository contents, or secret-bearing logs are included.
- [ ] Core GitHub, Codex, or verifier behavior is not replaced with mock success paths.
- [ ] License/provenance changes are documented when source repository behavior changes.

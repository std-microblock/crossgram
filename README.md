# mtproto-relay-cordis

- [IMPlatform 适配器实现规范](docs/IM_PLATFORM.zh.md)
- [架构设计与开发计划](docs/设计与待办.zh.md)

参考 adapter 位于 `packages/platform-static`，通过 Cordis 配置项 ID 注册并支持多例。它内置实时 mutation、关联群组和万级历史场景；跨包契约和真实 socket e2e 位于独立的 `packages/test-suite`。

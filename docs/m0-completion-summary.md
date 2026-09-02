# M0 里程碑完成总结

更新日期：2026-09-02  
执行范围：[latest-development-plan.md](latest-development-plan.md) § 5

## 结论

M0 的代码偏差已经补齐，确定性门禁恢复：21/21 workspace 类型检查通过；全量测试中 590 项在受限沙箱通过，5 项 loopback 场景因沙箱禁止监听而分类失败，并已在允许 loopback 的环境单独验证 8/8 通过。真实 PostgreSQL 多会话并发用例已加入环境门禁，但当前本机数据库在协议连接阶段超时，因此不伪造“已通过”的外部证据。

| 工作包 | 状态 | 关键证据 |
|---|---|---|
| M0.1 设备绑定安全与一致性 | 代码完成，外部 DB smoke 待补证据 | CSPRNG、碰撞重试、注入时钟、数据库按用户事务锁、PGlite 4/4 |
| M0.2 类型依赖与 workspace 门禁 | 完成 | `pnpm typecheck` 21/21 |
| M0.3 测试可移植性与确定性 | 完成 | runner 23/23；loopback 8/8；修复测试误删系统临时目录 |
| M0.4 打包版本与产物门禁 | 完成 | Forge/工作流契约 31/31；版本、架构、必需产物 fail-closed |

## 修复内容

### 设备绑定

- 设备短码改用 `node:crypto.randomBytes`，碰撞采用有界重试。
- `reserveCodeSlot` 成为服务与存储共同的原子 seam，所有过期判断使用调用方注入时钟。
- PostgreSQL 新增 `lecoding_reserve_device_binding_code`：以 user id 派生 advisory transaction lock，在锁内重新检查活跃码数量并插入；这避免了 READ COMMITTED 下单条 `count + insert` 仍可并发超发的问题。
- 唯一 hash 冲突稳定映射为 `code_hash_conflict`，与内存 adapter 语义一致。
- 新增真实 PostgreSQL 多连接测试 `postgres-concurrency.test.ts`，由 `RUN_LIVE_POSTGRES_CONCURRENCY=1` 显式启用。

### 全仓质量门禁

- `@lecoding/anthropic-model` 补齐直接 workspace 依赖。
- `@lecoding/test-harness` 增加 `typecheck`，根门禁现在实际覆盖 21 个 workspace。
- desktop release workflow 改为执行根级 `pnpm typecheck` 与 `pnpm test`。
- runner Git fixture 兼容 Git 2.22，并检查子进程退出码。
- 修复 local/desktop runner 测试清理路径：此前会删除整个 `tmpdir()`，导致 Vitest 产生大量 SSR `ENOENT`；现在只删除测试自己创建的目录。
- 运维指标改用注入观察时钟；Docker 与真实模型测试保留显式环境 gate。

### 桌面发布

- tag 严格归一化：`v1.2.3 → 1.2.3`，`beta-v1.2.3 → 1.2.3-beta.0`；无 tag 的 `0.0.0` 和非法 semver 均拒绝构建。
- `appVersion` 同时写入 Forge `packagerConfig.appVersion`、`buildVersion`、Squirrel 标题与安装包文件名。
- CI 把 `matrix.arch` 传给 Forge 的 `--arch`，并在上传前校验版本、平台、架构和必需产物。
- release job 对缺失资产使用 `fail_on_unmatched_files: true`；M0 当前要求 Windows setup EXE/NUPKG/RELEASES 与 macOS DMG/ZIP，MSI/PKG 是否交付仍留给 M1 产品决策。

## 本次验证

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | 21/21 workspace 通过 |
| 设备绑定 + Forge + workflow 聚焦测试 | 52 通过，live PostgreSQL 1 项默认跳过 |
| runner 聚焦测试 | 23/23 通过 |
| `pnpm test -- --reporter=dot` | 590 通过、5 loopback 因沙箱 EPERM 失败、5 跳过 |
| `pnpm vitest run apps/worker/test/http-server.test.ts`（允许 loopback） | 8/8 通过 |
| live PostgreSQL 多会话测试 | 本机 `127.0.0.1:54321` TCP 端口可达，但 PostgreSQL 协议连接在 5 秒后超时；未计为通过 |

真实数据库复验命令：

```bash
set -a
source .env.local
set +a
RUN_LIVE_POSTGRES_CONCURRENCY=1 \
  pnpm vitest run packages/device-binding/test/postgres-concurrency.test.ts
```

预期：8 个并发请求在单用户上限为 1 时，恰好 1 个成功、7 个返回 `too_many_codes`。

## M0 后续外部证据

- 在健康的真实 PostgreSQL 上跑通上述多会话测试。
- 在 GitHub Actions 三个平台执行一次 tag dry-run，保存 Windows x64、macOS arm64、macOS x64 的产物清单。
- Docker 隔离和真实模型基线仍属于显式外部环境 gate。
- 正式签名、公证、安装包 E2E、MSI/PKG 产品决策属于 M1/M3，不纳入 M0 完成声明。

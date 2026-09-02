# LeCoding Agent 最新开发计划

更新日期：2026-09-02  
计划基线：`master` / `v0.0.1`（`4aff3ba`）  
执行口径：单人全职，按依赖顺序推进；每个切片通过公开 seam 进行红—绿—重构。

## 1. 当前结论

项目已经完成 Phase 0–3 的主要功能，Phase 4 的服务端基础、设备绑定、Local Runner、Desktop Runner、Electron 主进程安全骨架和跨平台打包流水线也已落地。当前瓶颈不再是基础架构，而是质量门禁、桌面用户闭环、本地 Runner 通信闭环和正式发布证据。

| 交付目标 | 当前估算 | 主要缺口 |
|---|---:|---|
| 服务器 / Web MVP 功能 | 约 92% | 全量门禁、真实模型与目标 Linux 证据 |
| 服务器 / Web 发布就绪 | 约 82%–87% | 稳定测试、兼容性、发布演练 |
| Phase 4A Connected Desktop | 约 60%–65% | Renderer、原生安全存储、签名、公证、安装包 E2E |
| Phase 4B Local Runner | 约 35%–45% | WSS、重连去重、三档文件权限、完整恢复与撤销 |
| Phase 0–4 总体 | 约 75% | Phase 4 用户闭环与正式发布证据 |

Phase 5 不进入本计划的固定工期。它必须等待至少数百个带 `verified + user accepted` 标签的真实 Run，并建立稳定的黄金任务回归后再启动。

## 2. 最新验证基线

2026-09-02 的本地复验结果：

- Git 工作区干净，`master` 与 `origin/master` 一致。
- `pnpm typecheck`：19/20 workspace 通过；`@lecoding/anthropic-model` 缺少对 `@lecoding/contracts` 的直接依赖。
- `pnpm test`：546 通过、28 失败、4 跳过。
- 失败中有 5 个是当前受限环境禁止 loopback 监听；17 个源于 Git 2.22 不支持测试夹具使用的 `git init --initial-branch`；其余包含设备绑定、指标时钟和 Windows 打包配置的稳定失败。
- GitHub Actions 已在 Windows x64、macOS arm64、macOS x64 三个 job 中成功执行，并发布 `v0.0.1`；但产物未签名、未公证，包内版本仍是 `0.0.0`，macOS x64 job 实际产生 arm64 产物，且没有 MSI / PKG。

上述数据是本计划的入口基线。任何阶段完成声明都必须由当次重新运行的证据替代，而不能只引用历史审计数字。

M0 修复后的最新证据见 [m0-completion-summary.md](m0-completion-summary.md)：`pnpm typecheck` 已达 21/21；确定性测试与允许 loopback 的 HTTP 测试已通过。真实 PostgreSQL 多会话测试已经落地，但健康数据库环境的通过证据仍待补齐。

## 3. 执行原则

1. 先恢复可信门禁，再继续扩展功能。
2. 新行为必须从公开 seam 编写失败测试，再实现最小修复。
3. 安全身份、审批、文件权限、恢复和发布签名必须失败关闭。
4. 文档中的“完成”必须对应可复现命令、测试结果或真实平台产物。
5. 每个工作包独立提交；禁止把门禁修复、功能扩展和无关重构混在同一提交。
6. 每个工作包先运行聚焦测试，合并前运行 `pnpm test` 和 `pnpm typecheck`。
7. 外部环境导致的跳过或失败必须显式分类，并提供在目标环境复验的命令与证据。

## 4. 里程碑总览

| 里程碑 | 目标 | 单人工期 | 依赖 |
|---|---|---:|---|
| M0 | 恢复全仓库可信质量门禁 | 3–5 个工作日 | 无 |
| M1 | 完成 Phase 4A Connected Desktop 用户闭环 | 7–12 个工作日 | M0 |
| M2 | 完成 Phase 4B Local Runner 闭环 | 10–15 个工作日 | M0、M1 的 UI / 凭据 seam |
| M3 | 完成正式发布证据和文档收口 | 3–5 个工作日 | M0–M2 |

预计：服务器 / Web 私有 Beta 还需 3–7 个工作日；严格完成 Phase 4A 还需约 2–3 周；严格完成 Phase 4A + 4B 还需约 4–6 周。

## 5. M0：恢复可信质量门禁

目标：消除稳定失败，使本地、CI 和审计使用同一套可复现门禁。

### M0.1 设备绑定安全与一致性

优先级：P0  
估时：1–2 天

- [x] 用 `node:crypto` 的密码学安全随机源替换 `Math.random()` 设备码生成。
- [x] 为短码碰撞增加有界重试；存储层以唯一约束原子拒绝重复 hash。
- [x] 让活跃码计数使用服务注入时钟，而不是存储内部的真实系统时间。
- [x] 将“检查上限 + 插入码”合并为原子存储操作，阻止并发超发。
- [x] 为碰撞、并发发码、过期清理、限额边界和重试耗尽补充测试。
- [x] 检查 PostgreSQL 与内存 adapter 的错误码和事务语义一致。

退出条件：

- 设备码不使用非安全随机源。
- 两个并发请求不能突破单用户活跃码上限。
- 碰撞不会覆盖已有未消费码。
- `packages/device-binding/test/*.test.ts` 全部通过。

### M0.2 类型依赖与 workspace 门禁

优先级：P0  
估时：0.5 天

- [x] 为 `@lecoding/anthropic-model` 声明测试和类型检查实际使用的直接 workspace 依赖。
- [x] 确认所有包在干净安装后不依赖根目录偶然 hoist 的未声明模块。
- [x] 在 CI 中运行全仓库 `pnpm typecheck`，而不只检查 desktop 子图。

退出条件：全新 `pnpm install --frozen-lockfile` 后，21/21 workspace 类型检查通过。

### M0.3 测试可移植性与确定性

优先级：P0  
估时：1 天

- [x] Local Runner 测试兼容 Git 2.22：使用 `git init` 后设置分支，或显式提高并验证最低 Git 版本。
- [x] 所有测试夹具检查 `spawnSync` / Git 初始化退出码，禁止静默进入后续断言。
- [x] 运维指标 reader 使用注入时钟生成 `observedAt`，固定时间测试不依赖真实系统时间。
- [x] loopback HTTP 测试在允许监听的 CI job 中运行；受限沙箱中应有明确分类而非混入业务失败。
- [x] 保留 Docker daemon 和真实模型测试的显式环境 gate。

退出条件：同一提交在开发机和 CI 上产生一致的通过、跳过和环境分类结果。

### M0.4 Windows 打包配置和版本一致性

优先级：P0  
估时：0.5–1 天

- [x] 统一 Squirrel `name`、`setupExe` 的实现与测试语义。
- [x] 从 tag 或发布输入将版本注入 desktop 包，禁止 `v0.0.1` 生成 `0.0.0` 产物。
- [x] 为 tag、预发布 tag、无 tag 开发构建分别增加测试。
- [x] CI 发现版本不一致、目标架构不一致或要求产物缺失时失败。

退出条件：发布 tag、包内版本、文件名、更新 feed 版本完全一致。

### M0 验收命令

```bash
pnpm vitest run packages/device-binding/test
pnpm vitest run packages/local-runner/test packages/desktop-runner/test
pnpm vitest run packages/run-events/test/postgres-operational-metrics.test.ts
pnpm vitest run apps/desktop/test/forge-config.test.ts
pnpm test
pnpm typecheck
```

## 6. M1：完成 Phase 4A Connected Desktop

目标：用户可安装桌面客户端，通过设备绑定连接服务器，并完成与 Web 一致的 Run 管理闭环。

### M1.1 React Renderer 与状态模型

优先级：P1  
估时：3–5 天

- [ ] 建立 Renderer 入口、路由和严格类型化的 `window.lecoding` hooks。
- [ ] 实现登录 / 设备绑定状态、项目选择和设备撤销页面。
- [ ] 实现 Run 创建、历史列表、详情恢复和断线状态。
- [ ] 实现时间线、审批、用户回答、steer、取消、Diff、验证证据和 keep/discard。
- [ ] Renderer 只能通过 preload 暴露的白名单 IPC；不得直接访问 Node、文件系统或原始网络凭据。
- [ ] 复用 Web 的 presentation / contract seam，避免维护两套状态语义。

退出条件：PRD Phase 4A 的 Run 管理功能与 Web 行为一致，并有组件测试和 IPC 集成测试。

### M1.2 原生凭据安全存储

优先级：P1  
估时：1–2 天

- [ ] 实现 Electron `safeStorage` 或 keytar 的 `SecureStore` adapter。
- [ ] 明确安全存储不可用、系统锁定、密钥损坏和迁移失败的行为。
- [ ] 加密文件 backend 只作为显式降级，并向用户显示降级状态。
- [ ] 登出、设备撤销和凭据过期必须清除本地凭据。

退出条件：明文设备 token 不进入日志、配置文件或 Renderer；macOS 与 Windows 均通过真实 OS 存储 smoke。

### M1.3 桌面端到端测试

优先级：P1  
估时：1–2 天

- [ ] 启动真实 Worker、PostgreSQL 和安装后的桌面客户端。
- [ ] 覆盖设备绑定、Run 创建、SSE 恢复、审批、Diff、验证、取消、keep/discard。
- [ ] 覆盖关闭应用后重新打开和设备被服务器撤销。
- [ ] 验证不受信任 IPC sender、外部导航和弹窗继续被阻断。

退出条件：Windows 与 macOS 至少各有一次真实安装包 E2E 证据。

### M1.4 正式安装包链路

优先级：P1  
估时：2–3 天，外部证书申请时间不计入编码工期

- [ ] 修复 macOS x64 job 实际生成 arm64 产物的问题。
- [ ] 明确是否交付 MSI / PKG；若 PRD 保留该要求，缺失时 CI 必须失败。
- [ ] 配置 Windows 代码签名证书。
- [ ] 配置 macOS Developer ID 签名和 notarization。
- [ ] 验证安装包签名、架构、版本、更新 feed 和签名更新拒绝逻辑。
- [ ] Release job 禁止同名资产互相覆盖。

退出条件：Windows x64、macOS arm64、macOS x64 产物可区分、已签名；macOS 已公证；自动更新只接受可信签名。

## 7. M2：完成 Phase 4B Local Runner

目标：桌面客户端可以安全地在用户本机执行 Run，同时保持服务器端 RunEngine、审批、事件和验证契约不分叉。

### M2.1 Runner WSS 协议

优先级：P1  
估时：3–4 天

- [ ] 定义版本化 WSS envelope、命令 ID、事件游标和错误码。
- [ ] 使用设备凭据认证 Runner，并绑定 user / project / device。
- [ ] 实现断线重连、指数退避、心跳和会话恢复。
- [ ] 服务端和 Runner 对重复命令进行幂等去重。
- [ ] 从最后确认游标续传事件，禁止丢失或重复执行副作用。
- [ ] 设备撤销后立即终止现有 WSS 会话。

退出条件：故意断网、重启桌面客户端和撤销设备后，Run 状态与副作用仍满足契约。

### M2.2 三档文件访问权限

优先级：P1  
估时：2–3 天

- [ ] 完整实现 `workspace_only`。
- [ ] 实现 `selected_directories`，路径由 OS 原生选择器授权并持久化为最小必要范围。
- [ ] 实现 `host_full` 的 OS 原生二次确认、醒目持续状态和一键降权 / 中止。
- [ ] 所有路径 canonicalize 后再判定；覆盖符号链接、大小写、Windows junction 和路径穿越。
- [ ] 每次工作区外访问进入不可变审计记录。

退出条件：三档权限的允许、拒绝和越权矩阵在 Windows/macOS 全部通过。

### M2.3 本地执行恢复与结果处置

优先级：P1  
估时：2–3 天

- [ ] Local Runner 重启后恢复 worktree 和 Run handle。
- [ ] 断线时不重复执行正在进行或结果未知的工具调用。
- [ ] keep/discard 幂等，且不污染源仓库。
- [ ] 取消覆盖准备、命令执行、验证和等待审批状态。
- [ ] 清理失败必须留下可观测的残留路径和人工恢复说明。

退出条件：崩溃窗口、断线和重复请求集成测试全部通过。

### M2.4 本地验证和安全基线

优先级：P1  
估时：2–3 天

- [ ] DesktopLocalEnvironment 运行与 ServerDockerEnvironment 相同的接口契约测试。
- [ ] 验证项目声明的 test/typecheck/lint/build 最低集合。
- [ ] 明确本地环境无法提供 Docker 等级 CPU / memory / PID 隔离，并在 UI 中展示差异。
- [ ] 固定 deny、protectedPaths 和 network.askDomains 在本地环境仍然生效。
- [ ] Renderer 不直接获得本机执行、文件或凭据能力。

退出条件：Phase 4B 的五项 PRD 退出条件均有直接代码与目标平台证据。

## 8. M3：正式发布证据与文档收口

目标：把“代码存在”提升为“目标环境可复现、可运维、可回滚”。

### M3.1 外部环境证据

优先级：P1  
估时：1–2 天

- [ ] 执行 Anthropic 真实黄金任务，并记录通过率、成本和时长。
- [ ] 在目标 Linux Docker daemon 上运行隔离测试。
- [ ] 重新运行 PostgreSQL Worker、failover、cancel reconnect 和 steering smoke。
- [ ] 记录桌面 Windows/macOS 安装包 E2E。

### M3.2 运维演练

优先级：P1  
估时：1–2 天

- [ ] 从 PostgreSQL + Artifact 备份恢复到空环境。
- [ ] 执行一次带 schema 变化的升级和回滚演练。
- [ ] 验证 Artifact retention、worktree cleanup 和失败残留告警。
- [ ] 验证旧桌面版本升级到当前正式版本。

### M3.3 审计和发布文档

优先级：P1  
估时：1 天

- [ ] 更新 README 的 workspace、桌面端和 Local Runner 描述。
- [ ] 更新 Phase 4 status / completion audit，删除过期测试数字。
- [ ] 明确哪些结论是确定性测试、开发环境 smoke 或目标生产环境证据。
- [ ] 生成版本发布说明、已知限制和回滚步骤。

退出条件：新部署者只依赖仓库文档即可安装、绑定设备、运行任务、备份、恢复、升级和回滚。

## 9. 发布门禁

以下条件全部满足后，才能把 Phase 4A 标记为完成：

- [ ] `pnpm test` 全部通过；只有明确的真实外部环境 gate 可以跳过。
- [ ] `pnpm typecheck` 21/21 workspace 通过。
- [ ] 设备绑定安全与并发测试通过。
- [ ] Windows x64、macOS arm64、macOS x64 安装包来自同一 tag，版本一致。
- [ ] 正式产物已签名，macOS 已 notarize。
- [ ] Renderer 完成 Web 等价 Run 管理闭环。
- [ ] 安装包 E2E 覆盖设备绑定、Run、审批、Diff、验证、取消和结果处置。
- [ ] 自动更新拒绝错误签名或错误版本的包。

以下条件全部满足后，才能把 Phase 4B 标记为完成：

- [ ] Runner WSS 断线重连、去重、续传和设备撤销测试通过。
- [ ] 三档文件访问权限和 OS 二次确认通过目标平台测试。
- [ ] 本地 worktree 不污染源仓库，keep/discard、取消和恢复均通过。
- [ ] 工作区外访问可审计，固定 deny 不可绕过。
- [ ] DesktopLocalEnvironment 通过与 ServerDockerEnvironment 相同的接口契约测试。

## 10. 推荐提交顺序

1. `fix(device-binding): make code issuance collision-safe and atomic`
2. `fix(ci): restore full workspace typecheck and test gates`
3. `test(local-runner): support the declared minimum Git version`
4. `fix(metrics): inject the observation clock consistently`
5. `fix(desktop): align package version architecture and artifacts`
6. `feat(desktop): ship the renderer run-management loop`
7. `feat(desktop): persist credentials in native secure storage`
8. `test(desktop): add installed-app end-to-end coverage`
9. `feat(local-runner): add authenticated resumable WSS transport`
10. `feat(local-runner): enforce three-tier host file access`
11. `test(local-runner): prove crash recovery and result disposition`
12. `docs: close phase four with target-platform evidence`

## 11. 第一周执行建议

第一周只承诺 M0，不同时启动 Renderer 或 WSS：

| 天 | 工作内容 | 当日退出条件 |
|---|---|---|
| Day 1 | 设备绑定失败测试、安全随机和碰撞处理 | 聚焦测试全绿 |
| Day 2 | 原子限额、PostgreSQL 一致性、并发测试 | 设备绑定全部测试全绿 |
| Day 3 | Anthropic 依赖、Git 兼容、指标时钟 | 类型检查全绿，相关聚焦测试全绿 |
| Day 4 | 桌面版本 / 架构 / 产物修复，强化 CI | 三平台 dry-run 产物清单正确 |
| Day 5 | 全仓库回归、loopback 复验、更新基线文档 | `pnpm test`、`pnpm typecheck` 满足门禁 |

M0 通过后再重新评估 M1 的 UI 范围和签名证书可用性；如果证书尚未就绪，Renderer 与安装包 E2E 可继续推进，但正式发布门禁不得降级。

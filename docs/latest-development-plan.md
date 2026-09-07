# LeCoding Agent 最新开发计划

更新日期：2026-09-03
计划基线：`master` / `v0.0.1`（`4aff3ba`）  
执行口径：单人全职，按依赖顺序推进；每个切片通过公开 seam 进行红—绿—重构。

## 1. 当前结论

项目已经完成 Phase 0–3 的主要功能，Phase 4 的服务端基础、设备绑定、Local Runner、Desktop Runner、Electron 主进程安全骨架和跨平台打包流水线也已落地。当前瓶颈不再是基础架构，而是质量门禁、桌面用户闭环、本地 Runner 通信闭环和正式发布证据。

| 交付目标 | 当前估算 | 主要缺口 |
|---|---:|---|
| 服务器 / Web MVP 功能 | 约 92% | 全量门禁、真实模型与目标 Linux 证据 |
| 服务器 / Web 发布就绪 | 约 82%–87% | 稳定测试、兼容性、发布演练 |
| Phase 4A Connected Desktop | 约 90%–92% | 真实安装、双平台 keychain、签名、公证、真实升级证据 |
| Phase 4B Local Runner | 约 35%–45% | WSS、重连去重、三档文件权限、完整恢复与撤销 |
| Phase 0–4 总体 | 约 81%–84% | Local Runner 闭环与正式发布证据 |

Phase 5 不进入本计划的固定工期。它必须等待至少数百个带 `verified + user accepted` 标签的真实 Run，并建立稳定的黄金任务回归后再启动。

## 2. 最新验证基线

2026-09-02 的本地复验结果：

- Git 工作区干净，`master` 与 `origin/master` 一致。
- `pnpm typecheck`：19/20 workspace 通过；`@lecoding/anthropic-model` 缺少对 `@lecoding/contracts` 的直接依赖。
- `pnpm test`：546 通过、28 失败、4 跳过。
- 失败中有 5 个是当前受限环境禁止 loopback 监听；17 个源于 Git 2.22 不支持测试夹具使用的 `git init --initial-branch`；其余包含设备绑定、指标时钟和 Windows 打包配置的稳定失败。
- GitHub Actions 已在 Windows x64、macOS arm64、macOS x64 三个 job 中成功执行，并发布 `v0.0.1`；但产物未签名、未公证，包内版本仍是 `0.0.0`，macOS x64 job 实际产生 arm64 产物。当时没有 MSI / PKG；M1 复评后已确认二者不属于消费者发布要求。

上述数据是本计划的入口基线。任何阶段完成声明都必须由当次重新运行的证据替代，而不能只引用历史审计数字。

M0 修复后的证据见 [m0-completion-summary.md](m0-completion-summary.md)：`pnpm typecheck` 20/20；确定性测试与允许 loopback 的 HTTP 测试已通过。真实 PostgreSQL 多会话测试已经落地，但健康数据库环境的通过证据仍待补齐。

M1 当前开发基线见 [m1-completion-summary.md](m1-completion-summary.md)。确定性测试已通过，但真实安装、双平台 keychain、签名、公证及真实升级证据尚未归档，因此 M1 仍处于验收中。

## 3. 执行原则

1. 先恢复可信门禁，再继续扩展功能。
2. 新行为必须从公开 seam 编写失败测试，再实现最小修复。
3. 安全身份、审批、文件权限、恢复和发布签名必须失败关闭。
4. 文档中的“完成”必须对应可复现命令、测试结果或真实平台产物。
5. 每个工作包独立提交；禁止把门禁修复、功能扩展和无关重构混在同一提交。
6. 每个工作包先运行聚焦测试，合并前运行 `pnpm test` 和 `pnpm typecheck`。
7. 外部环境导致的跳过或失败必须显式分类，并提供在目标环境复验的命令与证据。

## 4. 里程碑总览

| 里程碑 | 目标 | 单人工期 | 依赖 | 状态 |
|---|---|---:|---|---|
| M0 | 恢复全仓库可信质量门禁 | 3–5 个工作日 | 无 | 已完成 |
| M1 | 完成 Phase 4A Connected Desktop 用户闭环 | 7–12 个工作日 | M0 | 验收中（代码链路完成，外部证据待补） |
| M2 | 完成 Phase 4B Local Runner 闭环 | 14–22 个工作日 | M0、M1 的 UI / 凭据 seam | 代码完成（2026-09-03）；目标平台证据待补，见 [m2-completion-summary.md](m2-completion-summary.md) |
| M3 | 完成正式发布证据和文档收口 | 7–11 个工作日（实施文档建议，证书与目标机器等待时间另计） | M0–M2 | 进行中：本机可做项已完成，外部证据全部待验收，仅达 RC 状态，见 [m3-completion-summary.md](m3-completion-summary.md) |

预计：服务器 / Web 私有 Beta 还需 3–7 个工作日；严格完成 Phase 4A 还需约 2–3 周；严格完成 Phase 4A + 4B 还需约 5–8 周。M2 原估时 10–15 天建立在应用层路径检查假设上；确认采用 OS 级文件权限强制后，调整为 14–22 个工作日。

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

退出条件：全新 `pnpm install --frozen-lockfile` 后，所有含 typecheck 任务的 workspace 均通过（M0 完成时实测 20/20）。

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

### M1.1 React Renderer 与框架无关状态模型

优先级：P1  
估时：3–5 天  
状态：**代码修复完成，里程碑验收未关闭**（2026-09-03），详见 [m1-completion-summary.md](m1-completion-summary.md)

- [x] 提取共享 `@lecoding/run-controller` 深模块：承载 Run 状态转换与 SSE cursor 续传、去重和重连；不得依赖 React 或 DOM。投影层与 SSE 编排落在同批新建的 `@lecoding/presentation`。
- [x] 将 `run-stream` 对 `LeCodingClient` 的直接依赖收窄为 `RunEventSource` interface，并提供 Web HTTP/SSE 与 Desktop IPC 两个 adapter。
- [x] 建立 React + Vite Renderer 入口和路由；React 只作为 View adapter，通过 `useSyncExternalStore` 订阅共享 controller，不在 hooks 中复制业务状态机。
- [x] Main 持有 Client SDK、设备凭据和 SSE 连接；preload 暴露类型化事件订阅与 unsubscribe，不向 Renderer 暴露 token、原始网络客户端或 `ipcRenderer`。
- [x] 实现登录 / 设备绑定状态、项目选择和设备撤销页面。
- [x] 实现 Run 创建、历史列表、详情恢复和断线状态。
- [x] 实现时间线、审批、用户回答、steer、取消、Diff、验证证据和 keep/discard。
- [x] Renderer 只能通过 preload 暴露的白名单 IPC；不得直接访问 Node、文件系统或原始网络凭据。
- [x] Web 手写 DOM 与 Desktop React View 消费同一 `RunConsoleController`、presentation 和 contract seam，避免维护两套状态语义。

退出条件：PRD Phase 4A 的 Run 管理功能与 Web 行为一致；框架无关 controller 通过纯 Vitest 行为测试，Web HTTP/SSE 与 Desktop IPC adapter 通过同一 contract suite，React 测试只验证用户可见渲染和命令绑定。
实测：controller 50 + reconnect 12、presentation 26 + run-stream 8、Renderer 组件 7、IPC gateway 7 全通过。
新增 PR 门禁 `.github/workflows/ci.yml`，使上述确定性测试在每个 PR 上运行，而不只在打 tag 时运行。

**顺带修复的三个阻塞缺陷**（原计划未列出）：

1. `apps/desktop/src/main/index.ts` 的 `webPreferences` 写的是 `preload: undefined`，preload 从未挂载，`window.lecoding` 根本不存在。
2. 全仓库没有生产 Electron bootstrap，`package.json` 的 `main` 指向只导出工厂函数的模块，打包后的应用无法启动；新增 `src/main/electron.ts`。
3. `forge.config.ts` 的 `rendererEntry` 指向不存在的 `apps/renderer/dist/index.html`，已改为 `dist/renderer/index.html` 并由 CI 的 `build:renderer` 产出。

### M1.2 原生凭据安全存储

优先级：P1  
估时：1–2 天  
状态：**代码路径完成，验收待办**；macOS / Windows 真实 OS 存储 smoke 尚未归档

- [x] 实现 Electron `safeStorage` 的 `SecureStore` adapter（`safeStorage` 是 cipher 不是 store，密文落 0o600 JSON 文件）。
- [x] 明确安全存储不可用、系统锁定、密钥损坏和迁移失败的行为：一律抛 `SecureStoreUnavailableError`，不静默丢弃凭据。
- [x] 加密文件 backend 只作为显式降级，并通过 `session.credentialState` 推送、在 UI 常驻显示降级状态。
- [x] 登出、设备撤销和凭据过期必须清除本地凭据。

退出条件：明文设备 token 不进入日志、配置文件或 Renderer；macOS 与 Windows 均通过真实 OS 存储 smoke。
实测：secure-store 43 测试全通过（含 safeStorage 11、后端选择 11）；深业务 E2E 断言推送流量中不含 `accessToken`。真实 OS 存储 round-trip 已并入 [desktop-m1-smoke-checklist.md](evidence/desktop-m1-smoke-checklist.md)。

### M1.3 桌面端到端测试

优先级：P1  
估时：1–2 天  
状态：**自动化完成，退出条件未满足**；真实安装包黄金 smoke 待目标平台执行

- [x] 建立无 GUI desktop application harness：`RunConsoleController → Desktop IPC adapter → 真实 Main handlers → Client SDK → 真实 Worker HTTP 服务`（`apps/desktop/test/run-loop.integration.test.ts`）。
- [x] 在 application harness 覆盖设备绑定、Run 创建、SSE 推送、审批、Diff、结果处置、设备撤销，以及不受信任 IPC sender、外部导航、弹窗阻断。
- [x] 每个 PR 运行 controller、Renderer/IPC contract 与 Electron 安全策略的确定性测试；不得用脆弱 GUI 自动化承担业务分支回归。（新增 `.github/workflows/ci.yml`，push / PR 触发 `pnpm typecheck` + `pnpm test`）
- [x] 安装包 smoke 自动化（`installed-app.smoke.test.ts`）：校验打包产物的 Renderer 入口、preload/main 入口、全部原生二进制架构与包内版本；由 `LECODING_INSTALLED_APP_PATH` / `LECODING_INSTALLED_APP_ARCH` 环境 gate 控制。
- [x] 结果分类显式化：环境 gate 以「跳过 + 原因」呈现，不记为通过；`docs/evidence/` 下的归档模板要求记录 tag、产物 SHA-256、OS/架构、签名结果与步骤。
- [ ] release candidate 在 Windows 与 macOS 的真实安装包上各执行两条黄金 smoke（[desktop-m1-smoke-checklist.md](evidence/desktop-m1-smoke-checklist.md)）：安装/绑定/完成 Run/查看证据/处置，以及关闭重开/恢复/设备撤销。

退出条件：application harness 对完整桌面业务闭环全绿；Windows 与 macOS 各有一次真实安装包黄金 smoke。GUI 不要求穷举业务分支，但安装、原生安全存储、打包资源和 Electron 运行时安全不得只由 mock 证明。
实测：深业务 E2E 4/4（其中一条覆盖真实 `Controller → IPC adapter → Main → SDK → Worker`；受限沙箱显式跳过），安装产物结构 smoke 在未提供真实产物时保持跳过，不能替代平台黄金 smoke。

### M1.4 正式安装包链路

优先级：P1  
估时：2–3 天，外部证书申请时间不计入编码工期  
状态：**发布链路完成，退出条件未满足**；签名、公证和真实升级验证待外部证书及目标平台

- [x] 固化消费者产物矩阵：Windows x64 交付 Squirrel `Setup.exe` + `full.nupkg` + `RELEASES`；macOS arm64/x64 各交付 DMG + ZIP。M1.4 不交付 MSI / PKG。
- [x] 删除凭据驱动的条件式 `maker-pkg`；凭据决定构建能否执行，不能静默改变同一 tag 的产物集合。
- [x] macOS arm64 固定运行于 `macos-15`，x64 固定运行于 `macos-15-intel`；禁止发布构建使用浮动 `macos-latest`。
- [x] 构建前校验 Node `process.arch` 匹配 matrix（并在 macOS 探测 Rosetta 转译）；继续向 Forge 显式传递 `--platform` 和 `--arch`。
- [x] 打包后校验中间 `.app`、解压后的 ZIP / DMG / NUPKG 内主二进制及全部 `.node` 原生模块，禁止只根据文件名判定架构。
  - 实现方式：纯 Node 解析 Mach-O / PE / ELF 头（`apps/desktop/src/build/architecture.ts`），不依赖 `lipo`——Windows runner 没有 `lipo`，且外部工具会让校验无法在本地复现。
  - 判定按**架构集合**而非单一值：universal（fat）二进制只要包含目标架构即视为可发布；「文件名说 x64、实际只有 arm64 slice」必须被拒绝。
- [x] Release job 使用包含 version/platform/arch 的唯一资产名，禁止同名资产互相覆盖，并对每个平台必需产物 fail-closed。
- [x] 签名证据步骤：macOS 跑 `codesign --verify --deep --strict` + `spctl --assess`，Windows 跑 `Get-AuthenticodeSignature`，结果写入 `signing-evidence.txt`；`LECODING_REQUIRE_SIGNED_ARTIFACTS=true`（tag 推送默认）下未签名即失败。release-gate job 汇总三方证据，任一架构未签名则整条 release 只能作为 pre-release 发布。
- [x] 企业部署 profile 延后到出现明确 MDM/组织分发需求后再立项；届时使用独立 workflow 评估 WiX MSI 与 macOS PKG，不混入消费者自动更新 feed。
- [ ] 配置 Windows 代码签名证书。（外部依赖）
- [ ] 配置 macOS Developer ID 签名和 notarization。（外部依赖）
- [ ] 验证签名更新拒绝逻辑的真实升级路径。（需真实签名产物，排入 M3 运维演练）

退出条件：同一 tag 产生已签名的 Windows Squirrel 三件套与 macOS 双架构 DMG/ZIP；macOS 已公证；runner、Node、容器内二进制和原生模块架构均与 matrix 一致；自动更新只接受可信签名。
实测：architecture 25、release-assets 10、forge-config 31、release-workflow 6 全通过；`release-gate` job 已就位。自动更新安装门会验证 Ed25519 清单签名、目标平台/架构/版本及 Artifact SHA-256；在发布密钥、签名清单和真实平台证据到位前不得关闭 M1。

## 7. M2：完成 Phase 4B Local Runner

目标：桌面客户端可以安全地在用户本机执行 Run，同时保持服务器端 RunEngine、审批、事件和验证契约不分叉。

执行顺序固定为 `M2.1 WSS → M2.2 权限 → M2.3 恢复 → M2.4 验证基线`。每个工作包独立提交；每个纵向切片必须先通过公开 seam 编写失败测试，再实现最小行为，先跑聚焦测试，工作包关闭前再跑 `pnpm test` 和 `pnpm typecheck`。外部环境缺失只能标记为目标平台验收待办，不能等同于功能完成。

### M2 开工前决策门

以下决策必须在编码前全部锁定，避免权限和恢复阶段反向修改 WSS 协议：

- [x] WSS 传输采用成熟的 `ws` 作为 Worker 与 Desktop Main 的 Adapter；版本化协议核心保持纯 TypeScript、零运行时依赖，禁止手写 RFC 6455 framing。
- [x] 三档文件权限由独立 Local Runner 的 OS Sandbox Adapter 在创建子进程时最终强制；Desktop Main 签发 Run 级 `FileAccessGrant`；PolicyEngine 只承担固定 deny 和权限升级审批。
- [x] WSS 身份证明采用设备 Bearer（`hello` 首帧携带 accessToken，凭据不进 URL 与日志）；设备私钥 challenge-response 留待 PRD 后续收紧。
- [x] Local Runner 本轮以内嵌 Desktop Main 的形态验证协议与权限，独立签名进程拆分留待独立工作包。
- [x] macOS 采用 Seatbelt（SBPL，经 `sandbox-exec`，启动探针失败即失败关闭）；Windows 采用 argv 围栏 + 真实进程树终止（`taskkill /T /F`），**不创建 Job Object、不做内核级 FS 限制**，能力报告如实标注 `argv_fence` 并说明为 best-effort；内核级 FS 限制（AppContainer）列为目标平台待办。
- [x] `selected_directories` 由 OS 原生目录选择器授权，签发时 canonicalize 并收敛为最小必要集合；重启后经持久化 grant 恢复，撤销即失效。
- [x] 恢复状态由 Runner 持有最终权威（durable handle journal + 命令 started/settled 记录）；未知执行结果一律按 `command_interrupted` 保守结算，绝不重放。
- [x] 本轮不归档 Windows/macOS 真实平台证据，M2 只标记「代码完成、平台验收待办」；证据清单见 [desktop-m2-smoke-checklist.md](evidence/desktop-m2-smoke-checklist.md)。

### M2.1 Runner WSS 协议

优先级：P1  
估时：3–5 天

- [x] 新建纯 TypeScript Runner 协议模块和小型 `RunnerTransport` interface；`ws` 仅存在于 Worker/Desktop Adapter。
- [x] Local Runner 主动建立出站连接；生产使用 `wss://`，TLS 默认由部署入口终止，测试使用 loopback `ws://`。
- [x] 定义版本化 WSS envelope、命令 ID、事件游标和错误码。
- [x] 使用设备凭据认证 Runner，并绑定 user / project / device。
- [x] 实现断线重连、指数退避、心跳和会话恢复。
- [x] 服务端和 Runner 对重复命令进行幂等去重。
- [x] 从最后确认游标续传事件，禁止丢失或重复执行副作用。
- [x] 设备撤销后立即终止现有 WSS 会话。
- [x] 固定子协议版本，限制最大消息、发送队列和背压；默认禁用压缩（客户端与服务端 `perMessageDeflate: false`）。WebSocket ping/pong 只判断连接存活，业务恢复使用独立的 resume / ack cursor。
- [x] 凭据只由 Main/Runner 持有，不进入 URL、日志、Renderer 或普通错误消息。

实施切片：先跑通认证后的单连接和单命令往返，再依次加入心跳、重连、去重、游标续传和设备撤销。退出条件：故意断网、重启桌面客户端和撤销设备后，Run 状态与副作用仍满足契约。

### M2.2 三档文件访问权限

优先级：P1  
估时：5–8 天

- [x] 控制面准入：Server Docker 只接受 `workspace_only`；另外两档只允许在线 Local Runner；远端只能降权，不能绕过本机确认升权。组织策略禁用 `host_full` 留待服务端策略面扩展。
- [x] Desktop Main 通过 OS 原生交互签发仅绑定当前 Run 的 `FileAccessGrant`（目录选择器 / host_full 危险确认；对话框缺失即拒绝，绝不降级为文本输入）。
- [x] 在 Local Runner 增加 `HostSandbox` seam，由 macOS/Windows Adapter 在创建进程时施加最终文件权限；能力报告如实标注每档实际强制等级，未达等级即拒绝执行。
- [x] 完整实现 `workspace_only`；`selected_directories` 来自 OS 原生选择器并收敛为最小必要集合；`host_full` 需要 OS 原生二次确认。
- [x] canonicalize 预检和审计覆盖符号链接、大小写、Windows junction、路径穿越及不存在目标的最近已存在父目录；越权时进程不被创建。
- [x] 每次工作区外访问进入不可变审计记录（append-only、0o600、注入时钟）；现有 `ApprovalGate` 和 `HostAccessLog` 只算交互/审计，不算权限强制证据。
- [ ] 为 PolicyEngine 增加明确的 scope escalation capability；保留凭据、浏览器数据、钥匙串和宿主控制入口等固定 deny（固定 deny 已验证生效）。清理当前从未参与决策的 `CapabilityRequest.fileAccessScope`，避免虚假安全承诺。

实施切片：`workspace_only → selected_directories → host_full/降权/中止`。退出条件：三档权限的允许、拒绝和越权矩阵在 Windows/macOS 全部通过，并有 OS 强制而非仅应用层检查的直接证据。

### M2.3 本地执行恢复与结果处置

优先级：P1  
估时：3–5 天

- [x] Local Runner 重启后恢复 worktree 和 Run handle（durable handle journal + `recoverRunState`）。
- [x] 断线时不重复执行正在进行或结果未知的工具调用（started/settled 差集按 `command_interrupted` 结算）。
- [x] keep/discard 幂等，且不污染源仓库（已消失的 worktree 视为成功；首次决定永久生效）。
- [x] 取消覆盖准备、命令执行、验证和等待审批状态（同一 cancel 路径 + 引擎侧 abort）。
- [x] 清理失败必须留下可观测的残留路径和人工恢复说明（residual 记录含路径、原因、处置步骤）。

实施切片：断线恢复 → Runner 重启 → 未知执行结果 → keep/discard 恢复。退出条件：崩溃窗口、断线和重复请求集成测试全部通过。

### M2.4 本地验证和安全基线

优先级：P1  
估时：3–4 天

- [x] DesktopLocalEnvironment 运行与 ServerDockerEnvironment 相同的接口契约测试（`runRunEnvironmentContractSuite`，三适配器共用；Docker 套件受 daemon gate 显式跳过）。
- [ ] 验证项目声明的 test/typecheck/lint/build 最低集合。
- [x] 明确本地环境无法提供 Docker 等级 CPU / memory / PID 隔离，并在 UI 中展示差异（`RunnerStatePush.sandbox.isolationGaps` + `LocalIsolationNotice`）。
- [x] 固定 deny、protectedPaths 和 network.askDomains 在本地环境仍然生效（`local-policy-baseline.test.ts`）。
- [x] Renderer 不直接获得本机执行、文件或凭据能力（`renderer-local-boundary.test.ts` 钉死 preload 暴露面）。
- [ ] 同一套公开契约测试依次运行内存 Adapter、macOS Adapter 和 Windows Adapter；真实平台证据按决策门约定归档。

退出条件：Phase 4B 的五项 PRD 退出条件均有直接代码与目标平台证据。

M2 调整后总估时为 **14–22 个工作日**。若退回仅使用 TypeScript `realpath` / 前缀判断，可以维持旧的 10–15 天估时，但该实现不能声称满足安全的三档文件访问权限。

## 8. M3：正式发布证据与文档收口

目标：把“代码存在”提升为“目标环境可复现、可运维、可回滚”。

执行按「本机可做 / 外部待验收」拆分，详见 [m3-implementation-plan.md](m3-implementation-plan.md) 第 2 节与本轮状态 [m3-completion-summary.md](m3-completion-summary.md)。

**定性**：M3 未达成发布判定。本机完成了 CI 根因定位、PolicyEngine 无效字段清理、retention 确定性验证与文档收口；M3.A2 更新生产链路接线、M3.B 全部目标环境证据、M3.C 备份恢复与 schema 演练均未执行（缺 API key、PostgreSQL、Docker、证书与目标机器）。按实施文档 §3 最终判定条款，当前只交付 RC 与未完成清单，不把未执行写成通过。

已完成的代码工作：

- [x] **M3.0 CI 根因定位**：远端失败为 `packages/runner-protocol` 测试文件缺 `RunnerCommandOutcome` 导入；本地因 turbo 缓存未暴露。修复已随未推送提交补上，当前 HEAD 零缓存 25/25 通过。**「同 SHA CI 全绿」需推送后复核，推送由你执行。**
- [x] **M3.A1（部分）**：删除 `CapabilityRequest.fileAccessScope`——该字段从未参与决策，保留会制造虚假安全承诺。本轮不实现 scope escalation。`environment.prepare` 的 scope 保留（环境真实消费），固定 deny 与 Run 级 deny list 不变。
- [x] **M3.C（部分）**：retention worker 新增 9 条确定性测试（调度、上报、residual、失败路由、并发与生命周期）；cleanup/residual 告警此前已覆盖。**「七日边界删哪些行」由 PostgreSQL store 实现且无内存版本，故这些测试不构成真实 PostgreSQL 证据。**

未完成（均标记「待目标环境」，验收标准与命令见 m3-completion-summary.md §4）：

- [ ] M3.A2 更新清单生产与 Main 接线（`installVerifiedUpdate` 调用点仅见测试）
- [ ] M3.B 全部外部证据：Linux 隔离、Docker 契约、PostgreSQL smoke/并发、Anthropic 黄金任务、签名公证、三平台 smoke
- [ ] M3.C 备份恢复与 schema 升级/回滚演练
- [ ] M3.D 剩余：README 更新、Phase 4 audit 更新、证据索引、release notes 定稿

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
- [ ] `pnpm typecheck` 全 workspace 通过（计数口径见下）。
- [ ] 设备绑定安全与并发测试通过。
- [ ] Windows Squirrel 三件套与 macOS arm64/x64 DMG/ZIP 来自同一 tag，版本和内部架构一致；MSI/PKG 不属于消费者发布门禁。
- [ ] 正式产物已签名，macOS 已 notarize。
- [ ] Renderer 完成 Web 等价 Run 管理闭环。
- [ ] application harness 覆盖完整业务闭环；Windows/macOS 安装包黄金 smoke 覆盖安装、绑定、Run、重启恢复和设备撤销。
- [ ] 自动更新拒绝错误签名或错误版本的包。

以下条件全部满足后，才能把 Phase 4B 标记为完成：

- [x] Runner WSS 断线重连、去重、续传和设备撤销测试通过。（确定性测试；真实网络抖动证据待归档）
- [ ] 三档文件访问权限和 OS 二次确认通过目标平台测试。（代码与确定性测试完成；macOS kernel 级与 Windows `argv_fence` 级证据待归档，Windows 内核级 FS 限制为已声明缺口）
- [x] 本地 worktree 不污染源仓库，keep/discard、取消和恢复均通过。
- [x] 工作区外访问可审计，固定 deny 不可绕过。
- [x] DesktopLocalEnvironment 通过与 ServerDockerEnvironment 相同的接口契约测试。

对应证据清单：[desktop-m2-smoke-checklist.md](evidence/desktop-m2-smoke-checklist.md)。

## 10. 推荐提交顺序

M0（已完成）：

1. `fix(device-binding): make code issuance collision-safe and atomic`
2. `fix(ci): restore full workspace typecheck and test gates`
3. `test(local-runner): support the declared minimum Git version`
4. `fix(metrics): inject the observation clock consistently`
5. `fix(desktop): align package version architecture and artifacts`

M1（验收中）：

6. `refactor(web): extract the shared presentation and Run console controller`
7. `fix(desktop): mount the preload and add the production Electron bootstrap`
8. `feat(desktop): ship the renderer run-management loop`
9. `feat(desktop): persist credentials in native secure storage`
10. `test(desktop): add the no-GUI application harness and installed-app smoke`
11. `fix(worker): mount the device-binding routes on the Worker HTTP server`
12. `fix(ci): build macOS arm64/x64 natively and verify real binary architectures`
13. `docs: close phase 4A code paths and record the M1 verification baseline`

M2（代码完成，平台证据待补）：

14. `feat(runner-protocol): add authenticated resumable WSS transport`
15. `feat(local-runner): enforce three-tier host file access`
16. `test(local-runner): prove crash recovery and result disposition`
17. `test(desktop): add the local verification and security baseline`
18. `docs: close phase four code paths and record the M2 verification baseline`

M3（未开始）：

19. `docs: close phase four with target-platform evidence`

## 11. M2 第一周执行建议

第一周先关闭剩余决策门，再完成 M2.1 的最小可信纵向链路；不并行启动 M2.2 的平台实现：

| 天 | 工作内容 | 当日退出条件 |
|---|---|---|
| Day 1 | 确认 WSS 身份证明、Runner 进程形态和恢复权威 | 协议身份、进程和持久化责任无未决歧义 |
| Day 2 | 验证 macOS/Windows Sandbox 机制与目录授权恢复方案 | 两个平台均有可执行的 Adapter 方案和失败关闭路径 |
| Day 3 | 先写协议解析、版本拒绝、认证和单命令往返失败测试 | `RunnerTransport` 公开 seam 与 envelope 契约固定 |
| Day 4 | 实现纯协议模块、Worker `ws` Adapter 和 Main/Runner 客户端 Adapter | loopback 单连接、认证、命令往返全绿 |
| Day 5 | 增加心跳、背压和断连状态测试，运行工作包回归 | M2.1 第一纵向切片通过聚焦测试、`pnpm test` 和 `pnpm typecheck` |

M1 的真实安装、签名、公证和升级证据可以独立归档，但不得打断 M2 的依赖顺序。若任一 Sandbox 机制验证失败，应暂停 M2.2 并修订范围或工期，不能退回只做路径前缀检查后仍宣称完成三档权限。

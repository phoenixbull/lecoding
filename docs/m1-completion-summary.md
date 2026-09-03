# M1 开发完成度与验收状态

更新日期：2026-09-03
执行范围：[latest-development-plan.md](latest-development-plan.md) § 6 M1：完成 Phase 4A Connected Desktop
前置基线：[m0-completion-summary.md](m0-completion-summary.md)（`pnpm typecheck` 20/20，`pnpm test` 585 通过 / 4 跳过）

## 1. 目标回顾

用户可安装桌面客户端，通过设备绑定连接服务器，并完成与 Web 一致的 Run 管理闭环。

| 工作包 | 范围 | 状态 |
|---|---|---|
| M1.1 | 共享 controller + React 视图适配器 | 代码完成；真实安装验收待办 |
| M1.2 | 原生凭据安全存储 | 代码完成；双平台 keychain smoke 待办 |
| M1.3 | 桌面端到端测试（深业务 + 产物结构 smoke） | 自动化完成；平台黄金 smoke 待办 |
| M1.4 | 正式安装包链路 | 链路完成；签名、公证、真实升级证据待办 |

因此本文不再把 M1 描述为已验收完成；只有第 5 节列出的外部证据全部归档后，才能关闭里程碑。

## 2. 验收命令与结果

| 命令 | 期望 | 实测 |
|---|---|---|
| `pnpm install --frozen-lockfile` | 干净安装无 drift | exit 0 |
| `pnpm typecheck` | 全部 workspace 通过 | **23/23 通过**（新增 2 个 package，另有 `@lecoding/test-harness` 无 typecheck 任务） |
| `pnpm test` | 全量门禁 | **817 通过 / 9 跳过 / 0 失败；103 文件通过 / 4 跳过；EXIT=0** |
| `pnpm vitest run apps/desktop/test` | 桌面端全部通过 | **193 通过 / 4 跳过**（15 个文件通过 / 1 个文件跳过） |
| `pnpm vitest run apps/desktop/test/run-loop.integration.test.ts` | 深业务 E2E | **4 通过**（受限沙箱中显式跳过并给出原因） |
| `pnpm vitest run apps/desktop/test/installed-app.smoke.test.ts` | 安装包 smoke | **4 跳过**（未设置 `LECODING_INSTALLED_APP_PATH`），已用合成产物验证通过 / 失败两条路径 |

### vs M0 基线

| 指标 | M0 基线 | M1 完成时 |
|---|---:|---:|
| workspace typecheck | 20/20 | **23/23** |
| `pnpm test` 通过数 | 585 | **817** |
| 失败数 | 0 | **0** |
| 桌面端测试数 | 约 90 | **193 通过 / 4 跳过** |

## 3. 各工作包变更摘要

### 3.1 M1.1 共享 controller 与 React 视图适配器

**问题**：`apps/web/src/main.ts` 用 1080 行手写 DOM 承载全部 Run 状态语义；桌面端若照抄会形成两套分叉的状态语义，若改用 React hooks 自研则会把业务锁死在框架里。

**做法**：按用户决策「选 React，但不选 React 状态架构」——共享 controller 拥有状态语义，React 只做 View 适配器。

- 新建 `packages/presentation`：把 `apps/web/src/presentation.ts`（零 DOM 纯投影层）与 `run-stream.ts`（SSE 编排）迁入。`run-stream.ts` 的入参从 `client: LeCodingClient` 改为端口 `RunEventSource`，使同一份 cursor 续传 / `sequence` 去重 / 重连 / 终态移交语义同时服务 Web HTTP/SSE 与桌面 IPC 推送。
- 新建 `packages/run-controller`：`createRunConsoleController` 产出不可变 `RunConsoleState` 快照并通知订阅者，只依赖两个端口 `RunGateway`（能力）与 `RunEventSource`（事件）。覆盖 initialize / logout / selectProject / createRun / selectRun / cancel / discard / approve / reject / editAndApprove / answer / steer / loadArtifact / revokePolicyRule。
- `apps/web` 瘦身为薄 DOM 渲染层：新增 `gateway.ts`（`SdkRunGateway`）与 `events.ts`（`SdkRunEventSource`），`main.ts` 只剩装配与 `render(state)`，删除 10 个模块级可变变量。
- 新建 `apps/desktop/src/renderer`：React 19 + Vite 7，16 个组件覆盖五屏（连接绑定 / Run 控制台 / 变更与 Diff / 审批与用户回答 / 设备与凭据管理）；`use-controller-state.ts` 用 `useSyncExternalStore` 订阅（约 5 行），不持有任何 Run 状态语义。

**三个被修复的阻塞缺陷**：

1. `apps/desktop/src/main/index.ts` 的 `webPreferences` 写的是 `preload: undefined`，preload 从未挂载，`window.lecoding` 根本不存在。
2. 全仓库没有生产 Electron bootstrap：`createDesktopMain` / `createPreloadBridge` 只在测试中被调用，而 `package.json` 的 `main` 指向只导出工厂函数的 `dist/main/index.js`。新增 `src/main/electron.ts` 作为真实入口。
3. `forge.config.ts` 的 `rendererEntry` 指向不存在的 `apps/renderer/dist/index.html`，改为 `dist/renderer/index.html` 并由 CI 的 `build:renderer` 产出。

**IPC 契约扩展**：`IPC_CHANNELS` 从 11 个扩到 25 个，补齐 `session.openGitHubLogin`、`config.load`、`runs.approve` / `runs.reject` / `runs.editApprove`、`runs.answer`、`runs.steer`、`runs.changes`、`runs.artifact`、`runs.subscribe` / `runs.unsubscribe`、`policy.list` / `policy.revoke`、`session.status`。新增 `PUSH_CHANNELS = ["runs.event", "runs.streamState", "session.credentialState"]`，preload 只暴露 `onRunEvent` / `onStreamState` / `onCredentialState` 三个具名订阅函数，**不暴露 `ipcRenderer.on` 本身**。

**SSE 归属**：Renderer 的 CSP 是 `connect-src 'self'`、且 `sandbox: true`、凭据不得进入 Renderer，因此 SSE 由 main 进程持有。新增 `src/main/stream-broker.ts`，用 `followRunEventStream` 做续传与去重，再通过 `webContents.send("runs.event", …)` 推送；窗口关闭与 `before-quit` 时中止订阅。

### 3.2 M1.2 原生凭据安全存储

- `packages/secure-store/src/safe-storage-store.ts`（新增）：Electron `safeStorage` 适配器。`safeStorage` 是 cipher 而不是 store，密文落 0o600 JSON 文件；系统锁定 / 密钥损坏 / 迁移失败抛 `SecureStoreUnavailableError`，绝不静默丢弃凭据。
- `packages/secure-store/src/atomic-json.ts`（新增）：抽出 tmp + rename 的原子写，与 `encrypted-file-store.ts` 共用。
- `packages/secure-store/src/select-backend.ts`（新增）：`createSecureStoreWithFallback` 按 `safeStorage → 加密文件 → 抛错` 选择后端，禁止静默降级到内存；降级原因通过 `session.credentialState` 推送并在 UI 常驻展示（`DegradedStorageBanner`）。
- `apps/desktop/src/main/secure-store-factory.ts`（新增）：选取后端、暴露 health、登出与设备撤销时清除命名空间。

### 3.3 M1.3 桌面端到端测试

按用户决策拆两层：

- **深业务 E2E**（`apps/desktop/test/run-loop.integration.test.ts`）：真实 Worker HTTP 服务（loopback 临时端口）+ 真实 client SDK + 真实设备绑定服务 + 真实 main 进程 IPC 分发；新增真实 Controller 与 Desktop IPC adapters 入口，覆盖从共享状态机到 Worker 的完整链路。Electron 壳与 RunEngine 仍分别由策略测试和引擎测试承担。
- **安装产物结构 smoke**（`apps/desktop/test/installed-app.smoke.test.ts`）：由 `LECODING_INSTALLED_APP_PATH` / `LECODING_INSTALLED_APP_ARCH` 环境 gate 控制，校验打包产物的 Renderer 入口、preload 与 main 入口、所有原生二进制的实际架构、包内版本不为 `0.0.0`。它不启动 GUI、不等价于真实安装或 keychain smoke。
- **人工验收清单**：`docs/evidence/desktop-m1-smoke-checklist.md`，覆盖三平台 × 安装 / 绑定 / Run 闭环 / 重启撤销 / 安全回归五组。

**顺带发现并修复的真实缺口**：设备绑定 HTTP 路由（`packages/device-binding/src/http.ts`）此前**从未挂载到 Worker**，桌面端根本无法绑定设备。现已接入 `WorkerControlPlane.devices` 并在 `http-server.ts` 中于 API bearer 检查之前路由（因为 `exchange` 按设计不携带会话）。为此 `RunApiPrincipal` 增加可选 `email`，`createPostgresRunApiAccessControl` 的 `authenticate` 联查 `users` 表。

### 3.4 M1.4 正式安装包链路

- **原生 runner**：macOS arm64 → `macos-15`，macOS x64 → `macos-15-intel`（原为 `macos-latest`，已是 arm64 硬件，这正是「x64 job 产出 arm64 产物」的根因）。
- **架构校验**（`apps/desktop/src/build/architecture.ts` 新增）：纯 Node 解析 Mach-O / PE / ELF 头，不依赖 `lipo`（Windows runner 没有）。校验三个层次——runner（`process.arch` + Rosetta 探测）、打包后的 `.app` / `.exe`、以及解压后的 ZIP / DMG / NUPKG 内部；覆盖所有 `.node` 原生插件。判定按**架构集合**而非单一值：universal（fat）二进制只要包含目标架构即视为可发布，而「文件名说 x64、实际只有 arm64 slice」必须被拒绝。
- **资产唯一性**（`apps/desktop/src/build/release-assets.ts` 新增）：GitHub release 资产按文件名寻址，同名会静默覆盖。校验无重名、每个资产都带版本号、macOS 资产必须带自己的架构且不得出现另一个架构。
- **移除 maker-pkg**：默认消费者版本不交付 MSI / PKG（Windows 仅 Squirrel，macOS 仅 ZIP + DMG）。
- **签名证据**：`ci-desktop-make.mjs` 在 macOS 跑 `codesign --verify --deep --strict` + `spctl --assess`，在 Windows 跑 `Get-AuthenticodeSignature`，结果写入 `signing-evidence.txt`。`LECODING_REQUIRE_SIGNED_ARTIFACTS=true`（tag 推送时默认开启）下未签名即失败。release-gate job 汇总三方证据，任一架构未签名则整条 release 只能作为 pre-release 发布。
- **发布门禁**：新增 `release-gate` job，先拒绝同名资产，再依据真实签名证据决定 `prerelease`。

### 3.5 评审发现并修复的缺陷

M1 完成后按 `code-review` skill 做了标准（Standards）与规格（Spec）双轴评审，以下缺陷由评审发现并已修复，全部先补失败测试再改实现：

| 缺陷 | 影响 | 修复 |
|---|---|---|
| `fat_arch_64` 条目大小写成 28 字节（实为 32） | universal 二进制从第二个 slice 起全部读偏，架构判定基于错误数据 | 改为 32 字节并增加真实 universal 二进制（`/bin/echo` 等）的多 slice 读取测试 |
| `signing-evidence.txt` 三个 job 同名 | release-gate 的重复名校验**恒命中**，正式发布永远失败 | 改为 `signing-evidence-<platform>-<arch>.txt`，并补充契约测试断言 |
| Windows 只校验 `.nupkg`，用户实际运行的 `Setup.exe` 未校验 | 架构校验漏掉了最关键的产物 | 用 `electron-winstaller/vendor/7z.exe` 解压 7z 自解压包后纳入校验 |
| 没有 PR 门禁 | `pnpm test` / `pnpm typecheck` 只在打 tag 时跑，回归会一直潜伏到下次发版 | 新增 `.github/workflows/ci.yml`（push / PR 触发） |
| `compareVersions` 的预发布用字符串比较 | `1.0.0-rc.10` 会被判为低于 `1.0.0-rc.2`，更新器拒绝更新的候选版本 | 按 SemVer 2.0.0 § 11.4 实现点分标识符的数值比较 |
| 可 steer 的状态集合在三处各写一遍（controller、Web DOM、React 组件） | 服务端引擎已有自己的门控，UI 三份副本会各自漂移 | 统一收敛到 `@lecoding/presentation` 的 `canSteerRun` |
| `ChangesPanel` 自行推导 `succeeded \|\| failed` | 绕过了共享的 `canResolveRunResult` | 改用共享谓词 |
| `devices.revoke` 载荷声明了 `projectId` 但被 `void` 丢弃 | 契约承诺了一个并未生效的过滤条件 | 删除该字段；`devices.list` 的 `projectId` 改为真正生效的客户端过滤 |
| `device_revoked` / `code_consumed` / `code_expired` 三个错误码声明后从未产生 | Renderer 无法区分「设备已失效，去重新绑定」与「上游错误」 | `errorCodeFor` 映射设备绑定错误码；移除从未产生的 `credential_expired` |
| 导出的载荷接口缺少文档注释 | 违反 `AGENTS.md` 的注释规约 | 为 IPC 载荷、preload 导出类型、`ConsoleTab`、`ChannelValidator` 等补充职责与调用方义务说明 |
| `ci-desktop-make.mjs` 里两个近乎相同的 symlink 实体化循环 | Duplicated Code | 合并为一个带 `afterCopy` 回调的 `replaceSymlinksWithCopies` |

## 4. 修改文件清单

| 文件 | 类型 | 说明 |
|---|---|---|
| `packages/presentation/**` | 新增 | 共享投影层 + SSE 编排（从 `apps/web` 迁入） |
| `packages/run-controller/**` | 新增 | 框架无关 Run 控制台状态机 |
| `apps/web/src/gateway.ts`、`events.ts` | 新增 | SDK 适配 `RunGateway` / `RunEventSource` |
| `apps/web/src/main.ts` | 重写 | 薄 DOM 渲染层，删除 10 个模块级变量 |
| `apps/web/src/presentation.ts`、`run-stream.ts` | 删除 | 迁至 `packages/presentation` |
| `apps/desktop/src/renderer/**` | 新增 | React 视图适配器（16 组件 + 2 gateway + 1 hook） |
| `apps/desktop/src/main/electron.ts` | 新增 | 生产 bootstrap（此前缺失，应用无法启动） |
| `apps/desktop/src/main/stream-broker.ts` | 新增 | main 侧 SSE 持有与推送 |
| `apps/desktop/src/main/secure-store-factory.ts` | 新增 | 凭据后端选取与 health |
| `apps/desktop/src/main/index.ts` | 修改 | 修 preload 未挂载、清调试输出、补新通道分发 |
| `apps/desktop/src/main/host.ts` | 修改 | `webContents.send`、原生能力抽象、`ClientSdk` 补齐 |
| `apps/desktop/src/preload/index.ts` | 修改 | 白名单事件订阅（`onRunEvent` 等） |
| `apps/desktop/src/shared/ipc-contract.ts` | 修改 | 11 → 25 通道 + 3 推送通道 |
| `packages/secure-store/src/safe-storage-store.ts` | 新增 | Electron `safeStorage` 后端 |
| `packages/secure-store/src/select-backend.ts` | 新增 | 显式降级链与 health |
| `packages/secure-store/src/atomic-json.ts` | 新增 | 原子写，两个后端共用 |
| `apps/desktop/src/build/architecture.ts` | 新增 | Mach-O / PE / ELF 架构解析与校验 |
| `apps/desktop/src/build/release-assets.ts` | 新增 | 资产唯一性与版本 / 架构一致性 |
| `apps/desktop/src/build/forge-config.ts` | 修改 | 移除 maker-pkg |
| `apps/worker/src/index.ts`、`http-server.ts`、`api.ts`、`postgres-access-control.ts` | 修改 | 挂载设备绑定路由、主体携带 email |
| `packages/device-binding/package.json` | 修改 | 暴露 `./postgres` 子路径 |
| `.github/workflows/desktop-release.yml` | 修改 | 原生 runner 矩阵、release-gate、签名证据 |
| `scripts/ci-desktop-make.mjs` | 修改 | renderer 构建、架构预检、归档内校验、签名证据 |
| `docs/evidence/desktop-m1-smoke-checklist.md` | 新增 | 人工验收清单与证据归档模板 |

## 5. 遗留风险与交接事项

### 5.1 需要外部依赖或目标平台的证据

以下项在本次工作中已把**代码路径与自动校验**补齐，但「目标平台证据」仍缺，必须由真实环境补上：

| 项 | 缺什么 | 由谁补 |
|---|---|---|
| Windows / macOS 安装包人工 smoke | 三平台各一次真实安装与闭环 | 按 `docs/evidence/desktop-m1-smoke-checklist.md` 执行 |
| Windows 代码签名 | `CSC_LINK` / `CSC_KEY_PASSWORD` secrets | 证书申请后配置 |
| macOS Developer ID 签名 + 公证 | `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` | 开发者账号后配置 |
| 自动更新拒绝错误签名 | 真实签名产物的升级路径验证 | M3 运维演练 |

证书未就绪时：手工 workflow 可生成实验性 pre-release；tag 推送默认启用 `LECODING_REQUIRE_SIGNED_ARTIFACTS=true` 并失败关闭。Forge 不存在可生效的布尔 `verifySignature` 开关；更新安装必须通过代码中的 Ed25519 清单签名和 Artifact SHA-256 安装门。

### 5.2 环境 gate（非回归）

`pnpm test` 的 9 个跳过全部是显式环境 gate，不是业务失败：

- `installed-app.smoke.test.ts`（4）：需要真实打包产物路径
- `docker-environment.test.ts` 的 2 个：需要 Docker daemon
- `live-agent-model-baseline.test.ts` × 2（2）：需要 Anthropic API key
- `device-binding/test/postgres-concurrency.test.ts`（1）：需要真实 PostgreSQL

深业务 E2E 在禁止 loopback 监听的沙箱中同样显式跳过并打印原因。

### 5.3 已知非阻塞问题

- `macos-15-intel` 是本次为原生 x64 构建选择的新 runner 标签；若 GitHub 后续调整 Intel runner 命名，需同步更新 workflow 与 `release-workflow.test.ts` 的断言。
- Windows 上的架构校验依赖两个命令：NUPKG 用系统 `tar`，`Setup.exe` 用 `electron-winstaller` 自带的 `7z.exe`。两者缺失时 `ci-desktop-make.mjs` 都以「无法解压以校验架构」失败——失败关闭，不静默跳过。
- React 19 的 `act` 环境标志已在 `renderer-app.test.tsx` 中显式设置；新增组件测试时需沿用。
- typecheck 计数口径已从 20 提到 23（新增 `presentation` 与 `run-controller` 两个 package；`@lecoding/test-harness` 无 typecheck 任务不计入）。计划文档 § 9 旧的「21/21」表述已同步修正。
- `packages/run-engine` 内部的 `isLiveSteerableStatus` 与服务侧门控保持独立：UI 的 `canSteerRun` 只是预测，真正的拒绝仍在服务端。两者必须同步修改，否则 UI 会给出一个服务端随后拒绝的入口。

## 6. 复现验收

```bash
pnpm install --frozen-lockfile
pnpm typecheck                       # 期望 23/23
pnpm test                            # 期望 817 通过 / 9 跳过 / 0 失败, EXIT=0
pnpm vitest run apps/desktop/test    # 期望 193 通过 / 4 跳过
```

带真实产物时：

```bash
LECODING_INSTALLED_APP_PATH=<打包 .app 或 win-unpacked 路径> \
LECODING_INSTALLED_APP_ARCH=arm64 \
  pnpm vitest run apps/desktop/test/installed-app.smoke.test.ts
```

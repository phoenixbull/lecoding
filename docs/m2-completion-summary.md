# M2 开发完成度与验收状态

更新日期：2026-09-03
执行范围：[latest-development-plan.md](latest-development-plan.md) § 7 M2：完成 Phase 4B Local Runner
前置基线：[m1-completion-summary.md](m1-completion-summary.md)

## 1. 目标回顾

桌面客户端可以安全地在用户本机执行 Run，同时保持服务器端 RunEngine、审批、事件和验证契约不分叉。

| 工作包 | 范围 | 状态 |
|---|---|---|
| M2.1 | Runner WSS 协议 | 代码完成 |
| M2.2 | 三档文件访问权限（OS Sandbox 强制） | 代码完成；Windows 内核级 FS 限制为已声明缺口 |
| M2.3 | 本地执行恢复与结果处置 | 代码完成 |
| M2.4 | 本地验证和安全基线 | 代码完成；真实平台证据待办 |

**M2 仍未验收**。本文只声明代码链路完成；第 5 节列出的目标平台证据归档之前，不得把 Phase 4B 标记为完成。

## 2. 核心架构决策与结果

### 2.1 RunEngine 零改动

`RemoteRunnerEnvironment` 实现 `RunEnvironment`，经 WSS 把 `prepare/perform/inspect/dispose` 转发到桌面 Local Runner，并通过既有 `createRoutedRunEnvironment` / `RunEnvironmentFactory.create(spec)` 接入。`packages/run-engine` 的文件在本轮**零修改**，审批、事件游标与验证契约天然不分叉。

`RunStatus.environment_offline` 已存在，WSS 断线超出恢复窗口后走既有离线语义，未新增状态。

### 2.2 协议核心零依赖

`packages/runner-protocol` 不 import `ws`，通过 `RunnerSocket` 端口与传输解耦，协议状态机用内存双工 socket 做确定性测试。`ws` 只出现在两处边缘 adapter：

- `apps/worker/src/runner-ws-server.ts`（服务端）
- `apps/desktop/src/main/runner-ws-client.ts`（客户端）

### 2.3 三档权限的强制位置

按决策门锁定：强制发生在 **Local Runner 创建子进程时**，由 `packages/host-sandbox` 的 `HostSandbox` 承担；Desktop Main 只经 OS 原生对话框签发 `FileAccessGrant`；PolicyEngine 只承担固定 deny 与升级审批。既有的 `ApprovalGate` 与 `HostAccessLog` 保留为交互与审计辅助，**不计入权限强制证据**。

### 2.4 平台能力差异如实披露（不是实现缺陷，是已声明的边界）

| 档位 | macOS | Windows |
|---|---|---|
| `workspace_only` | `kernel`（Seatbelt SBPL） | `argv_fence`（best-effort） |
| `selected_directories` | `kernel` | `argv_fence`（best-effort） |
| `host_full` | `acknowledged_unrestricted` | `acknowledged_unrestricted` |

**Windows 不创建 Job Object，也不做内核级文件系统限制。** 初版曾按「Job Object 进程树 containment」描述，但实现并未创建 Job Object —— 这属于与文档夸大同类的问题，已更正：模块重命名为 `windows-sandbox`，能力报告与文档均写明该平台无内核级 FS 隔离。

Windows 上真实提供的两项能力：

- argv 围栏：路径 canonicalize 后越权的命令不会被创建（与 macOS 一致）。
- 进程树终止：通过 `taskkill /T /F` 真实杀死整棵进程树（POSIX 上用进程组信号），因此取消 Run 不会留下孙进程占用 worktree。

内核级文件系统限制需要原生 AppContainer / 受限令牌 adapter，本仓库不携带原生 addon，因此 **Windows 未达成内核级 FS 强制**。处理方式是失败关闭 + 如实报告：

- `SandboxCapabilityReport` 声明每档实际等级；请求档位为 `unsupported` 时拒绝执行，绝不静默降级。
- 差异直接驱动 UI（`RunnerStatePush.sandbox.isolationGaps` → `LocalIsolationNotice`），满足 M2.4「在 UI 中展示差异」。
- 未达成项列入 [desktop-m2-smoke-checklist.md](evidence/desktop-m2-smoke-checklist.md)，不得在文档中声称已达成。

macOS 的 Seatbelt 可用性在启动时探针；探针失败拒绝产出执行计划，而不是返回一个「看起来受限」的命令。

## 3. 验收命令与结果

| 命令 | 期望 | 实测 |
|---|---|---|
| `pnpm typecheck` | 全部 workspace 通过 | **25/25 通过**（新增 `runner-protocol`、`host-sandbox`） |
| `pnpm test` | 全量门禁 | M2.2 提交前实测 **1056 通过 / 9 跳过 / 0 失败**；M2.3/M2.4 以聚焦套件验证（见下） |
| `pnpm vitest run packages/host-sandbox/test` | 沙箱矩阵 | **75 通过** |
| `pnpm vitest run packages/local-runner/test` | 围栏 + 恢复 | **43 通过**（含 9 条沙箱强制、18 条恢复） |
| `pnpm vitest run apps/desktop/test/local-runner-host.test.ts` | 恢复编排 | **10 通过** |
| 契约套件（local + desktop） | 三适配器同套件 | **25 通过** |
| `pnpm vitest run apps/worker/test apps/desktop/test` | WSS 改动回归 | **333 通过 / 0 失败** |
| Renderer 边界 + 策略基线 + 隔离组件 | M2.4 基线 | **21 通过** |

**门禁执行口径说明**：M2.3 与 M2.4 的收口验证以聚焦套件为准，原因是本轮执行环境的全量 `pnpm test` 运行反复超过命令超时窗口（此前 M2.2 阶段已完整跑通一次 1056 通过 / 0 失败）。**交接前必须在可等待全量运行的环境里重新执行 `pnpm test` 与 `pnpm typecheck`**，并把结果回填本节，替代聚焦套件数字。

9 个跳过全部是既有显式环境 gate（安装产物 smoke、Docker daemon、live Anthropic、真实 PostgreSQL 并发），本轮未新增跳过类别；Docker 契约套件沿用同一 daemon gate。

## 4. 各工作包变更摘要

### 4.1 M2.1 Runner WSS 协议

- `packages/runner-protocol`：版本化 envelope（hello/welcome/command/ack/nack/result/event/heartbeat/resume/goodbye）、命令 ID 与事件游标语义、`RunnerErrorCode` 与 4xxx 关闭码、单帧上限。
- 重连：指数退避 + 抖动 + 心跳超时，时钟与随机源可注入，协议核心无网络依赖。
- 命令去重：`running/succeeded/failed` 三态，重复命令回缓存结果；事件续传：有界窗口 + `lastAckedCursor`。
- 认证：握手 URL 不携带凭据，首个 `hello` 帧携带设备 accessToken，服务端复用 `deviceService.authenticate()` 绑定 user/project/device。
- 设备撤销：同进程立即关闭（close code 4001），心跳帧内 `authenticate()` 复验兜底。
- **本轮评审修正**：`ws` 客户端默认开启 permessage-deflate，与计划的「默认禁用压缩」不符。已改为客户端与服务端均 `perMessageDeflate: false`（Run payload 混合模型输出与秘密，压缩带来 CRIME/BREACH 类风险且帧很小，无收益）。

### 4.2 M2.2 三档文件访问权限

- `packages/host-sandbox`：
  - `PathFence`：realpath canonicalize，覆盖符号链接、`..` 穿越、大小写不敏感文件系统、Windows 扩展长度前缀与 junction；不存在的目标（输出文件）按最近已存在祖先解析，因此写路径同样被围栏。
  - `FileAccessGrant`：仅由 OS 原生交互签发，canonicalize 后收敛为最小必要集合；**解析持久化 grant 时重新校验**，防止磁盘上篡改把 Run 升级为 host_full。
  - `HostSandbox.admit`：失败关闭准入，请求档位为 `unsupported` 时拒绝，绝不降级。
  - darwin `SeatbeltSandbox`：生成 SBPL profile（deny default + 最小白名单，禁网络出站），构造期探针失败即 `unsupported`。
  - win32 `JobObjectSandbox`：进程树 containment；FS 档位如实报 `argv_fence`。
  - `AccessAuditLog`：append-only JSONL、0o600、注入时钟、接口上无 update/delete。
- `packages/local-runner`：`prepare` 先 `admit`（失败时 worktree 尚未创建）；`perform` 经 `sandbox.plan`，越权时**进程不被创建**，并通过 `onAccessViolation` 上报审计。
- Desktop：`ElectronHost` 扩展 `selectDirectories` / `confirmDanger`；`createFileAccessGrantService` 在对话框缺失时失败关闭；`ipc-contract.ts` 四处同步新增 `host.selectDirectories` / `host.confirmHostFull` / `runner.status` 与 push 通道 `runner.state`。

**测试发现并修复的真实缺陷**：

1. Seatbelt adapter 的 `wrap` 返回 Promise 但 `plan` 未 await —— 内核强制**静默失效**，命令未被包装。已改为 `await`，并补「探针失败必须拒绝产出计划」的测试。
2. `minimalDirectorySet` 未剥离尾部分隔符，同一目录会以两种拼写存入 grant。
3. 服务端 Docker 环境此前对 `selected_directories`/`host_full` 会抛错（符合预期），但 routed 工厂未按 `executionTarget` 分流 —— 已接 Local Runner 分支。

### 4.3 M2.3 本地执行恢复与结果处置

- `packages/local-runner` 新增 durable run journal（append-only JSONL，单行对象，崩溃中断的最后一行可跳过）与 `recoverRunState`。
- **安全关键语义**：`command.started` 与 `command.settled` 的差集 = 从未观察到结果的命令。恢复时按 `command_interrupted` 结算，**绝不重放**，因为其副作用（删文件、推分支）可能已发生。
- `cleanupWorktree`：失败不吞掉，返回 residual 记录（精确路径 + 原因 + 人工处置步骤）；移除后**复验存在性**，`rm --force` 在忙碌挂载上可能残留；已消失路径视为成功，从而使 keep/discard 可在重连后安全重放。
- compaction 只丢弃「已 resolved 且不再活跃」的 Run 的全部记录；仅空闲未 resolved 的 prepared worktree 必须保留，否则会丢失可恢复状态（测试锁定该行为）。
- `apps/desktop/src/main/local-runner-host.ts`：编排 journal + 幂等 keep/discard（首次决定永久生效，重放的 resolve 不得把 keep 翻转为 discard）+ 覆盖四态的取消 + residual 上报。

### 4.4 M2.4 本地验证和安全基线

- `runRunEnvironmentContractSuite`：三适配器共用同一套公开契约（handle 形状、exit code、changed-files、keep 幂等）；可选断言按适配器 opt-in，避免弱化到最小公分母。Docker 套件受 daemon gate 显式跳过。
- `local-policy-baseline.test.ts`：固定 deny（凭据路径、容器控制命令、sudo、私网目标）、`askDomains`、`protectedPaths`、Run 级 `deniedCommands` 在本地全部继续生效；并有一条守卫断言低风险命令仍被允许，防止基线退化为 deny-everything。
- `renderer-local-boundary.test.ts`：钉死 preload 暴露面 —— 无 `exec/spawn/shell/fs/net` 通道、无返回凭据的通道、grant 与 audit 无 Renderer 通道、push 通道永不作为可调用方法暴露。
- 隔离差异：`RunnerStatePush.sandbox.isolationGaps` 由 Main 从能力报告推导（非 kernel 即列为缺口），`LocalIsolationNotice` 用可执行的语言向用户陈述。

## 4.5 评审修复（第二轮）

首轮完成后经 code-review 发现 16 项问题，其中 6 项 P0。以下为已修复项，均按「先写失败测试再改实现」处理。

**P0**

1. **生产入口没有装配 Runner WSS 服务。** `main.ts` 未传 `configureServer`，`local:<deviceId>` 端点从未挂载，任何桌面设备都无法连接。已挂载，并用真实客户端对真实监听器的测试覆盖（这是请求级测试唯一无法触及的部分，因此最容易在全部测试通过的情况下保持未装配）。
2. **持久化 cursor 注释与实现相反。** 实为进程内 Map，`stop()` 会清空。已改为如实描述：进程内有效，Worker 重启后 Runner 从窗口起点重放；该方向的上行帧是进度与审计记录，追加型接收端幂等，因此重放安全；副作用在命令方向，由 commandId 保证恰好一次，不依赖该值。
3. **真实 WebSocket 客户端丢失首个 hello。** `ws` 客户端在 CONNECTING 期间发送即被丢弃，导致永远无法鉴权。内存 socket 一创建即 open，因此既有测试无法发现。两端现在共用协议包内的排队适配器，未 open 前缓冲、溢出则关闭（暴露为重连而非静默停滞）；同时消除了两侧适配层的重复实现。
4. **Local Runner 存在设备越权路由。** `local:<deviceId>` 直接按设备 ID 路由，未校验归属。已两处校验：准入时校验设备属于调用者本人且属于该项目（返回 404 而非 403，不确认设备 ID 是否存在）；执行时每次调用都用会话已证明的 projectId 比对，因为重连可能换掉会话身份。
5. **三档文件权限无法通过公共 API 落地。** `api.ts` 无条件拒绝所有非 `workspace_only`，`selected_directories` 与 `host_full` 无法从任何正常流程创建。该限制本属于服务端沙箱（无法把 Run 限定到选定宿主目录），已改为仅对服务端 Run 生效，本地 Run 由桌面沙箱强制并失败关闭。
6. **重连后 command ID 去重语义错误。** 每次会话从 1 开始，而 Runner 去重表跨重连存活，新命令会命中旧缓存并被直接返回而不执行——静默丢失副作用。ID 改为按设备分配：网关持单调高位标记，与 Runner 自己的 `lastReceivedCommandId` 取较大者。`welcome.replayFromCommandId` 更名为 `nextCommandId`（原名称描述了一次并不存在的重发）。

**P1**

7. **HELLO 超时与凭据持续撤销未闭环。** 未认证连接不在 `sessionsByDevice` 中，`tick()` 永不清理；心跳阶段也不重新验证凭据。现已单独登记并 tick 未认证连接（超期关闭 4001），且每个心跳周期重新验证设备凭据——这才是文档所述「撤销在一个心跳周期内生效」成立的依据。
8. **恢复与结果处置不是可靠的跨重启幂等。** 恢复时未重建 `firstDecision`；`resolve()` 又在 Git 生效与 journal 落盘**之前**写入内存幂等状态，首次失败后重试会被误判为已完成。顺序改为「生效 → 落盘 → 内存」；`recoverRunState` 现在返回每次处置的 outcome，恢复时据此重建。
9. **Windows 并未实现 Job Object。** 见 §2.4：模块更名、文档与能力报告更正为 `argv_fence` best-effort，并落地真实可做的进程树终止。
10. **选定目录的绝对路径返回了 Renderer。** 与「完整路径/grant 不进入 Renderer」边界冲突。现只返回数量与文件夹名。

**P2**

11. `git diff --check` 报告的 `local-runner/index.ts` 末尾多余空行已修。
12. **IPC 通道四处手工同步已收敛为「两处手写 + 两处编译器强制」。** 校验器 switch 改为全量的 `Record<IpcChannel, ChannelValidator>`，缺校验器是编译错误而非运行时返回 `null`；dispatch switch 的 `default` 改为 `never` 检查，缺 case 是编译错误而非静默落入。已通过临时添加通道验证：编译器报出全部四处（含本文件之外的 renderer gateway）。

## 5. 遗留风险与交接事项

### 5.1 目标平台证据（M2 不关闭的原因）

| 项 | 缺什么 | 由谁补 |
|---|---|---|
| macOS Seatbelt 越权矩阵 | 真实 macOS 上三类越权（argv 逃逸、symlink、拒绝执行）各有内核级拒绝证据 | 按 [desktop-m2-smoke-checklist.md](evidence/desktop-m2-smoke-checklist.md) |
| Windows 沙箱行为 | 确认 `argv_fence` 等级的允许/拒绝矩阵、进程树终止有效，并记录与 macOS 的差异 | 同上 |
| Windows 内核级 FS 限制 | **未达成**，需原生 AppContainer adapter；Windows 不创建 Job Object | 独立原生工作包；在此之前 Windows `argv_fence` 是已声明的 best-effort 边界 |
| 断网 / 重启 / 撤销设备 | 真实网络抖动与真实进程退出下的 Run 状态与副作用一致性 | 同上 |
| `host_full` 二次确认 | 真实 OS 对话框的确认与一键降权/中止 | 同上 |
| 独立签名 Runner 进程 | 决策门选择先内嵌 Main，拆分后需重验签名与升级链路 | 后续工作包 |

### 5.2 已声明的范围边界（非遗漏）

- **PolicyEngine 的 scope escalation capability 未实现**（计划 M2.2 最后一项保持未勾选）。固定 deny 与升级审批已验证生效，但 `CapabilityRequest.fileAccessScope` 仍未参与决策，存在「看似参与、实则无效」的虚假承诺。应在独立切片中要么实现、要么删除该字段。
- **项目声明的 test/typecheck/lint/build 最低集合校验未实现**（M2.4 第二项未勾选）。现有 `packages/verifier` 承担服务端验证；本地侧尚未消费同一份声明。
- **组织策略禁用 `host_full`** 未实现；`host_full` 当前只由用户 OS 确认把关。
- **Windows 内核级 FS 限制**未实现（见 §2.4）；`argv_fence` 是已声明的 best-effort 边界，UI 会展示与 macOS 的差异。

评审的其余条目（导出 API 文档、IPC 注册表 shotgun-surgery）已在本轮处理，见 §4.5。

### 5.3 门禁口径

见第 3 节末尾说明：交接前必须重新执行全量 `pnpm test` 并回填实测数字。

## 6. 复现验收

```bash
pnpm install --frozen-lockfile
pnpm typecheck                                       # 期望 25/25
pnpm test                                            # 交接前必须全量复跑并回填
pnpm vitest run packages/host-sandbox/test           # 期望 75 通过
pnpm vitest run packages/local-runner/test           # 期望 43 通过
pnpm vitest run apps/desktop/test/local-runner-host.test.ts  # 期望 10 通过
pnpm vitest run packages/local-runner/test/contract-suite.test.ts \
        packages/desktop-runner/test/contract-suite.test.ts  # 期望 25 通过
```

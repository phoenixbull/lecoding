# Desktop M2 Smoke Checklist（Phase 4B Local Runner 目标平台证据）

更新日期：2026-09-03
关联：[m2-completion-summary.md](../m2-completion-summary.md)、[desktop-m1-smoke-checklist.md](desktop-m1-smoke-checklist.md)

## 0. 归档规则

- 每条记录必须包含：日期、执行人、OS 版本与架构、应用构建来源（tag / commit）、产物 SHA-256。
- 「跳过」必须写明原因，不得记为通过。
- 本清单只覆盖 **M2（Local Runner）**；安装、绑定、升级类证据沿用 M1 清单。
- **任何一条未能归档，Phase 4B 都不得标记为完成。**

## 1. macOS Seatbelt 越权矩阵（要求 kernel 级证据）

前置：`sandbox.capabilities().tiers.workspace_only === "kernel"`，且启动探针通过。

| # | 场景 | 期望 | 证据 | 结果 |
|---|---|---|---|---|
| 1.1 | `cat /etc/hosts`（workspace_only） | 沙箱拒绝，进程不被创建，审计出现 `outOfScope` 记录 | 终端输出 + 审计文件尾部 | ☐ |
| 1.2 | worktree 内放置指向 `/etc` 的 symlink 后 `cat worktree/escape/passwd` | realpath 解引用后拒绝； Seatbelt 在内核层拒绝（即使 argv 是相对路径） | 终端输出 | ☐ |
| 1.3 | `pnpm test`（工作区内） | 正常执行，exit code 0 | 终端输出 | ☐ |
| 1.4 | `sandbox-exec` 探针被人为破坏（重命名二进制后重启） | 拒绝执行 Run，UI 显示不可强制，不静默降级 | 截图 + 日志 | ☐ |
| 1.5 | 审计文件权限为 0600，且无 update/delete 路径 | `ls -l` 显示 `-rw-------` | 终端输出 | ☐ |

## 2. Windows 沙箱行为（如实记录 argv_fence 等级）

前置：`sandbox.capabilities().tiers.workspace_only === "argv_fence"`。

| # | 场景 | 期望 | 证据 | 结果 |
|---|---|---|---|---|
| 2.1 | `cat C:\Users\...\secret.txt`（workspace_only） | 创建前拒绝，进程不被创建 | 终端输出 | ☐ |
| 2.2 | Windows junction 指向工作区外 | realpath 解引用后拒绝 | 终端输出 | ☐ |
| 2.3 | 大小写变体路径（`C:\WORK\...`） | 判定为同一位置，不产生假阳性拒绝 | 终端输出 | ☐ |
| 2.4 | 扩展长度前缀 `\\?\C:\...` | 正确解析并围栏 | 终端输出 | ☐ |
| 2.5 | `pnpm test`（工作区内） | 正常执行 | 终端输出 | ☐ |
| 2.6 | UI 能力报告 | 显示「文件访问在命令创建时强制，而非内核强制」及与 macOS 的差异 | 截图 | ☐ |

> **已声明缺口**：Windows 无内核级文件系统限制（需原生 AppContainer / 受限令牌）。记录本节时必须同时记录该缺口，不得表述为「与 macOS 等同」。

## 3. 三档权限与 OS 原生交互

| # | 场景 | 期望 | 证据 | 结果 |
|---|---|---|---|---|
| 3.1 | `selected_directories`：目录选择器选择 2 个目录 | grant 只含这 2 个目录（canonicalize + 最小集合），工作区外路径被拒 | grant 文件 + 终端输出 | ☐ |
| 3.2 | 取消目录选择器 | Run 不启动，无 grant 落盘 | UI + 文件 | ☐ |
| 3.3 | `host_full`：确认对话框勾选后 | Run 启动，grant 含 `dangerAcknowledgedAt` | 截图 + grant 文件 | ☐ |
| 3.4 | `host_full`：不勾选直接关闭 | Run 不启动，无 grant | UI | ☐ |
| 3.5 | `host_full` 运行中一键降权 / 中止 | 当前 Run 停止，后续 Run 回到低档位 | UI + 日志 | ☐ |
| 3.6 | 磁盘上手工删除 grant 的 `dangerAcknowledgedAt` 后重启 | 解析拒绝，Run 不得以 host_full 启动 | 日志 | ☐ |

## 4. 断网 / 重启 / 撤销设备

| # | 场景 | 期望 | 证据 | 结果 |
|---|---|---|---|---|
| 4.1 | Run 执行中拔网线 30s 后恢复 | 重连成功，事件从 `lastAckedCursor` 续传，无丢失、无重复副作用 | 服务端事件序列 + UI | ☐ |
| 4.2 | 命令执行中强杀桌面进程，重启后重连 | 该命令按 `command_interrupted` 结算，**不被重放** | journal 内容 + 服务端日志 | ☐ |
| 4.3 | 重启后存在未 resolved 的 worktree | Run handle 恢复，可继续 keep/discard | UI + journal | ☐ |
| 4.4 | keep 后重放同一 resolve 请求 | 返回首次决定，Git 状态只解析一次 | 服务端日志 | ☐ |
| 4.5 | 撤销设备（另一台设备上操作） | 该设备 WSS 会话立即关闭（close code 4001），桌面回到绑定页 | 服务端日志 + UI | ☐ |
| 4.6 | 多 Worker 部署下撤销设备 | 在一个心跳周期内被关闭（如实记录周期上限） | 服务端日志 | ☐ |
| 4.7 | 清理失败（在 worktree 内打开文件后 discard） | UI/日志出现 residual 路径 + 人工处置说明，worktree 仍存在 | 截图 | ☐ |

## 5. 隔离差异与 Renderer 边界

| # | 场景 | 期望 | 证据 | 结果 |
|---|---|---|---|---|
| 5.1 | 首次本地 Run | `LocalIsolationNotice` 列出 CPU/内存/PID 缺口；Windows 额外列出「非内核强制」 | 截图 | ☐ |
| 5.2 | 点击「我知道了」 | 本次会话内不再显示 | UI | ☐ |
| 5.3 | Renderer DevTools 检查 `window.lecoding` | 只含白名单通道与 4 个命名订阅函数；无 `exec/spawn/fs/net` | 截图 | ☐ |
| 5.4 | Renderer DevTools 执行 `require('child_process')` | 失败（sandbox + contextIsolation） | 截图 | ☐ |
| 5.5 | 服务端创建 Run 时请求本机不支持的档位 | 拒绝执行并记录，不静默降级 | 服务端日志 | ☐ |

## 6. 固定 deny 本地生效（抽查）

| # | 场景 | 期望 | 证据 | 结果 |
|---|---|---|---|---|
| 6.1 | 本地 Run 中模型请求读 `~/.ssh/id_rsa` | deny（即使 approvalMode = full_access） | 审批/审计记录 | ☐ |
| 6.2 | 本地 Run 中模型请求 `docker run -v /:/host` | deny | 审批/审计记录 | ☐ |
| 6.3 | 项目 `network.askDomains` 之外的域 | 强制 ask，用户未批准则不发出 | UI | ☐ |

## 7. 归档模板

```
### <平台> <日期> <执行人>
- OS: <版本> <arch>
- App: <tag 或 commit>  SHA-256: <产物摘要>
- Seatbelt/JobObject 探针: <通过/失败 + 原因>
- 结果: 1.1 ☐ 1.2 ☐ ... （逐条）
- 偏差与说明: <若有>
- 结论: <满足 M2 验收 / 存在缺口（列出）>
```

# LeCodex 项目长期记忆

## 工作方式（用户偏好）
- 大型工作项先制定执行计划（plan mode），经用户确认三个关键架构决策后按序连续推进，每个工作包独立提交（红-绿-重构，包末跑 `pnpm test` + `pnpm typecheck`）。
- 评审采用双轴（Standards/Spec）并行子代理，按 P0/P1/P2 分级；用户会要求"同样力度的评审"逐轮复核，直到无 P0/P1。
- 用户用中文交流；commit message 与代码注释用英文。

## 仓库约定（AGENTS.md）
- 导出的接口/类型/函数必须有文档注释，写明**职责与调用方义务**（调用方无法从类型推断的约束）。
- 注释解释意图与约束（状态转换/安全检查/持久化保证/并发假设/协议约束），不复述语法。
- 公开 seam 上做红-绿-TDD；每个切片聚焦测试，交接前全量 `pnpm test` + `pnpm typecheck`。
- 运行时依赖保持为零（仅 devDeps）；外部工具能自己解析就不引入（如自解析 Mach-O/PE/ELF 而非用 lipo）。`ws` 是唯一例外（经批准，仅限两处 adapter）。
- 安全边界失败关闭：能力报告如实报告弱项，未达等级拒绝执行而非静默降级。
- 外部环境依赖必须显式 gate（跳过+原因），不得记为通过。

## 环境陷阱
- 本机 Docker daemon 不稳定：任何 `docker` 探针必须 `spawnSync(..., { timeout: 5000 })`，否则 collection 阶段无限阻塞、全量测试永不退出。
- macOS `/var` → `/private/var` 符号链接：测试中比较路径必须先 realpath；grant/journal 里的路径必须 canonical（从 canonical 根 + runId 派生）。
- `execute_command` 约 50s 会回收 shell：长任务用 `nohup bash script.sh & disown` 分离（macOS 无 setsid），轮询用 `pgrep -f "vitest run"` 判断（pgrep 脚本名会误报）。
- vitest 全局未启用，测试文件须显式 `import { describe, it } from "vitest"`；jsdom 组件测试加 `/** @vitest-environment jsdom */` 并用 Testing Library。
- `exactOptionalPropertyTypes: true`：可选属性传 undefined 会报错，用条件展开。

## 当前里程碑状态
- M0 完成；M1 代码完成（签名/公证/平台 smoke 待外部证据）；M2 代码完成+全量门禁有效通过，**验收待办**（缺目标平台证据，见 docs/m2-completion-summary.md §5.2 与 docs/evidence/desktop-m2-smoke-checklist.md）。
- M2 架构：RunEngine 零改动——`RemoteRunnerEnvironment` 实现 `RunEnvironment`，经既有 `createRoutedRunEnvironment` 接入；协议核心 `packages/runner-protocol` 零依赖（`RunnerSocket` 端口），`ws` 仅在 Worker/Desktop 两处 adapter；三档文件权限由 `packages/host-sandbox` 在进程创建时强制（darwin Seatbelt=kernel，win32 argv_fence best-effort，其他 unsupported→失败关闭）。
- 遗留待拍板：PolicyEngine `fileAccessScope` 字段去留（建议删除）；Windows 原生 AppContainer 工作包；项目声明验证命令本地消费。

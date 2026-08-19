# AI Coding Agent — PRD 与技术设计方案书 v3

> **项目代号**：LeCodex
> **目标用户**：单团队内 5–20 名开发者  
> **交付等级**：可进入原型实施的设计基线  
> **日期**：2026-08-18  
> **版本**：v3.2（开工决策已确认，预留 PC 客户端）  
> **基于**：v2 设计评审、Claude Code / OpenAI Codex 官方能力对标

---

## 0. v3 变更摘要

v3 保留 TypeScript 全栈、Web-first、单 Agent 优先和容器隔离方向，但对执行底座做以下调整：

1. 将“模型输出 `finish`”与“任务验证成功”分离，引入独立 `Verifier`。
2. 将 SSE 从任务执行通道降为事件展示通道，引入持久化 `RunEngine + Worker`。
3. 每个任务使用独立可写 Git worktree；源仓库保持不被直接修改。
4. 用 `allow / ask / deny` 权限策略替代危险命令黑名单。
5. 网络从永久断网改为默认断网、按域名和任务临时授权的代理模式。
6. 将 Planner、Reflector 等浅模块收拢为少量深模块，以模块 interface 作为测试面。
7. 将自动 Prompt 进化移出 MVP，改为可审计、分作用域、可回滚的候选记忆机制。
8. 增加内部任务评测集、成本、延迟、人工接管率和回归门禁。
9. 把 Diff、恢复点、项目指令和任务取消提前到 MVP。
10. 多 Agent、MCP、PR 自动提交、自主经验发布继续延后，但核心数据模型预留扩展能力。

---

## 一、需求基线

### 1.1 产品定位

构建一个面向小团队的 Web Coding Agent。用户关联 Git 仓库并提交自然语言任务，Agent 在独立工作区内完成：

```text
理解任务 → 检索项目上下文 → 修改代码 → 执行验证 → 修正 → 展示证据与 Diff
```

产品首先追求“改动可靠、过程可控、结果可恢复”，不追求在首版覆盖 Claude Code 或 Codex 的全部终端、IDE、桌面、云端和多 Agent 能力。架构必须支持后续增加 PC 客户端，且不复制 Agent 内核。

### 1.2 目标用户与规模

| 维度 | 目标 |
|---|---|
| 用户 | 单一内部团队，5–20 名开发者 |
| 峰值并发 | 5 个活跃 Run；需通过压测确认资源配置 |
| 运维 | 1 人开发兼运维，优先单体应用 + 独立 Worker |
| 仓库 | 首期仅支持 Git 仓库；单 Run 单 worktree |
| 部署 | 单机 Docker Compose 起步，可迁移到托管数据库和独立 Worker |
| 成本 | 月度总预算 3000 元，以实际 token 和执行时长配额控制 |

### 1.3 核心用户故事

1. 用户选择仓库、分支并描述一个编码任务。
2. 用户可查看 Agent 当前进度、工具调用、审批请求和验证结果。
3. Agent 不直接污染用户主工作区；每次任务产出独立 Diff。
4. 用户可中止、恢复、接受或丢弃任务结果。
5. 系统重启、浏览器断开或 SSE 重连不会丢失任务状态。
6. 高风险命令、额外目录和网络访问需要策略允许或用户批准。
7. 用户可查看任务使用的项目指令、记忆、模型、成本和验证证据。
8. 后续 PC 客户端可复用同一项目、Run、审批、事件、Diff 和验证契约。
9. PC 客户端后续可选择连接服务器执行，或通过 Local Runner 操作用户明确授权的本机仓库。

### 1.4 产品成功指标

不再用单个 CRUD 示例作为唯一成功判据。建立 20–30 个内部黄金任务，覆盖：

- 小型功能开发
- Bug 修复
- 跨文件重构
- 补充测试
- 依赖升级
- 类型与 lint 修复
- 失败恢复与权限审批

MVP 发布门槛：

| 指标 | 门槛 |
|---|---:|
| 黄金任务一次运行验证通过率 | ≥ 60% |
| 已完成 Run 可恢复率 | 100% |
| 中止请求最终生效率 | ≥ 99% |
| 越权写入测试阻断率 | 100% |
| 高风险工具调用审计覆盖率 | 100% |
| 人工接管率 | 可观测，首期不设硬门槛 |
| 单任务 token / 成本 / 时长 | 可观测且支持硬配额 |
| 版本升级回归 | 核心指标不得显著退化 |

### 1.5 MVP 范围

| 能力 | MVP | 说明 |
|---|:---:|---|
| 多轮任务与工具循环 | ✅ | 使用原生结构化工具调用，不依赖解析自由文本 ReAct |
| 文件检索、读取、补丁修改 | ✅ | 修改以 patch 为主，完整写文件为受控补充 |
| 终端执行 | ✅ | 沙箱、超时、输出上限、权限策略 |
| 独立 Git worktree | ✅ | 每个 Run 独立工作区和恢复点 |
| 验证器 | ✅ | 测试、类型、lint、验收条件、Diff 证据 |
| 持久化 Run 与恢复 | ✅ | Worker 与 Web 请求生命周期解耦 |
| 权限审批 | ✅ | allow / ask / deny，支持会话级允许 |
| Diff 与结果接受/丢弃 | ✅ | MVP 核心交付体验 |
| 项目指令 | ✅ | 支持 `AGENTS.md`，兼容读取 `CLAUDE.md` |
| 基础项目记忆 | ✅ | 可查看、编辑、删除；默认不自动提升为系统规则 |
| 多用户认证与项目隔离 | ✅ | 单团队，不做公开多租户 SaaS |
| Web UI | ✅ | 任务、事件、审批、Diff、验证报告 |
| PC 客户端兼容契约 | ✅ | MVP 固化版本化 contracts 与 client SDK，不交付桌面 UI |
| PC 客户端应用 | ❌ | Phase 4A：服务器连接模式；Phase 4B：本机执行模式 |
| 模型路由 | ✅ | 至少两个 adapter；能力和工具语义归一化 |
| MCP / Skills / Hooks | ❌ | v1.1；MVP 只预留扩展 seam |
| 多 Agent | ❌ | v1.2；先证明单 Agent 可靠性 |
| 自动 Commit / PR | ❌ | Diff 稳定后增加 |
| Prompt 自动进化 | ❌ | 必须先有离线评测和人工发布流程 |
| 历史失败任务自动重放 | ❌ | 可能产生费用和外部副作用 |

### 1.6 非目标

- 不做模型训练或微调。
- MVP 不做 PC 客户端、IDE 插件和实时协同编辑；PC 客户端是明确的后续阶段，不属于永久非目标。
- 不承诺完全无人值守；遇到权限、需求歧义或风险操作应请求用户输入。
- 不允许 Agent 自主修改不可审计的全局系统提示词。
- 不允许 Run 默认访问宿主机密钥、Docker socket 或工作区外目录。
- 不把任意仓库中的文本视为可信系统指令。

---

## 二、技术决策 ADR

### 2.1 选择 TypeScript，但拆分 Web 与 Worker 生命周期

采用 TypeScript 统一开发语言：

- Web：Next.js + React
- Worker：独立 Node.js 进程
- 数据库：PostgreSQL
- 队列：`pg-boss`（PostgreSQL `SKIP LOCKED`）起步；达到实测瓶颈后再评估 Redis
- ORM：Drizzle 或同等级类型安全方案
- 沙箱：Docker adapter 起步
- LLM：官方 SDK 优先，统一模型 adapter

不在设计文档中锁死易过期的小版本。实现时建立兼容性矩阵，选择当期受支持版本并提交 lockfile。

`pg-boss` 负责持久化投递、并发、重试和过期任务回收；Run 业务状态仍以本项目的 `runs/run_events` 为事实来源。即使队列提供原子领取，启用重试后仍可能再次处理，因此所有工具副作用继续要求 `call_id` 幂等保护。参考：[pg-boss 官方文档](https://pgboss.io/)。

### 2.2 为什么不把 Agent Loop 放在 Next.js 请求中

长任务必须独立于 HTTP 请求生命周期。SSE 只订阅事件，不拥有任务：

```text
Browser ──HTTP──> Web/API ──enqueue──> PostgreSQL
   ▲                 │                    │
   │                 └──SSE read events──┤
   │                                      ▼
   └──────── progress / approval ───── Run Worker
                                          │
                                          ▼
                                   Worktree + Sandbox
```

### 2.3 为什么使用 worktree + 容器双层隔离

- worktree 隔离代码版本和并发修改。
- 容器隔离进程、文件系统、资源和网络。
- 两者解决的问题不同，不能互相替代。

### 2.4 为什么延后向量记忆和 Prompt 进化

20–30 次任务不足以稳定估计策略成功率。首期优先采用可审计的项目指令与结构化记忆；只有满足以下条件后才允许自动提出策略候选：

1. 有明确来源和项目作用域。
2. 有独立黄金任务验证。
3. 有人工批准和版本记录。
4. 可灰度、停用和回滚。

---

## 三、系统架构

### 3.1 总览

```text
┌─────────────────────────────────────────────────────────────┐
│ Web UI                                                      │
│ Projects / Runs / Timeline / Approvals / Diff / Verification│
└──────────────────────────────┬──────────────────────────────┘
                               │ HTTP + SSE
┌──────────────────────────────▼──────────────────────────────┐
│ Web/API                                                      │
│ Auth / Project access / Run commands / Event subscription    │
└──────────────┬───────────────────────────────┬──────────────┘
               │ enqueue / state               │ read events
┌──────────────▼───────────────────────────────▼──────────────┐
│ PostgreSQL                                                   │
│ Projects / Runs / Events / Approvals / Artifacts / Memories  │
└──────────────┬──────────────────────────────────────────────┘
               │ lease
┌──────────────▼──────────────────────────────────────────────┐
│ Run Worker                                                   │
│ RunEngine → ContextAssembler → Model → Tool calls             │
│      │             │                         │                │
│      ▼             ▼                         ▼                │
│ Workspace        Memory                 PolicyEngine          │
│      │                                       │                │
│      └──────────────> ExecutionSandbox <─────┘                │
│                              │                                │
│                              ▼                                │
│                           Verifier                            │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 PC 客户端演进架构

PC 客户端分两步实现：

```text
Phase 4A：Connected Desktop
Electron UI ── Client SDK ── HTTPS/SSE ── Web/API ── Server Worker

Phase 4B：Local Execution
Electron Renderer ── narrow IPC ── Desktop Main
                                      │
                                      ├── Client SDK ── HTTPS/SSE ── Control Plane
                                      │
                                      └── authenticated local channel ── Local Runner
                                                                            │
                                                                    local worktree/sandbox
```

- **Connected Desktop** 只是新的客户端 surface，执行仍发生在服务器，风险和实现成本较低。
- **Local Execution** 让 Local Runner 在用户电脑上访问经授权的仓库；控制面只下发 Run 命令和接收事件。
- Local Runner 主动建立出站 WSS 连接，不要求用户开放入站端口。
- Renderer、Desktop Main、Local Runner 是三个不同信任级别；Renderer 不直接访问文件系统、Shell、Git 或密钥。
- PC 客户端断开不改变服务器 Run 状态；本地 Run 失联进入 `environment_offline`，恢复连接后按事件游标续传。

### 3.3 Run 状态机

```text
queued → preparing → running ───────────────→ verifying → succeeded
                       │  ▲                       │
                       │  └── retryable failure ─┘
                       │
                       ├→ waiting_approval → running
                       ├→ waiting_user     → running
                       ├→ environment_offline → running
                       ├→ cancelling       → cancelled
                       └→ failed
```

约束：

- 状态迁移使用数据库事务和期望版本号，拒绝乱序更新。
- Worker 使用租约与心跳；租约过期的 Run 可由其他 Worker 接管。
- 每个工具调用有稳定 `call_id`；重试不得重复执行非幂等副作用。
- `cancel_requested_at` 一旦设置，Worker 在模型调用、命令和重试边界检查。
- `succeeded` 只能由 Verifier 产生，模型不能直接写入。
- 浏览器断线只影响展示，不影响 Run。
- Local Runner 失联时进入 `environment_offline`，停止下发新动作；设备恢复并重新证明身份后才可继续。

---

## 四、核心深模块

### 4.1 RunEngine

RunEngine 隐藏模型循环、失败恢复、预算、审批等待和事件记录。外部 interface 保持小而稳定：

```typescript
interface RunEngine {
  start(input: StartRun): Promise<RunId>;
  command(runId: RunId, command: RunCommand): Promise<void>;
  inspect(runId: RunId): Promise<RunView>;
}

type RunCommand =
  | { type: 'cancel' }
  | { type: 'steer'; message: string }
  | { type: 'answer'; requestId: string; value: unknown }
  | { type: 'approve'; approvalId: string; scope: 'once' | 'run' };
```

调用方无需理解 step、reflection 频率、重试或模型厂商事件格式。集成测试只通过该 interface 观察 Run 状态、事件和工作区结果。

### 4.2 RunEnvironment

RunEngine 只依赖一个执行环境 port，不感知任务运行在服务器 Docker 还是用户 PC：

```typescript
interface RunEnvironment {
  prepare(spec: EnvironmentSpec): Promise<EnvironmentHandle>;
  perform(handle: EnvironmentHandle, action: EnvironmentAction): Promise<EnvironmentResult>;
  inspect(handle: EnvironmentHandle): Promise<EnvironmentReport>;
  dispose(handle: EnvironmentHandle, outcome: 'keep' | 'discard'): Promise<void>;
}
```

真实 adapter：

- `ServerDockerEnvironment`：MVP adapter，内部组合 Workspace 与 ExecutionSandbox。
- `DesktopLocalEnvironment`：Phase 4B adapter，由 Local Runner 实现。
- `InMemoryEnvironment`：测试 adapter，只用于模块 interface 测试。

`EnvironmentSpec` 必须携带 `targetType`、仓库标识、授权文件范围、审批模式、资源预算和策略版本。所有 adapter 输出相同事件、Artifact、Diff 和 VerificationReport 语义。

### 4.3 Workspace

Workspace 将 Git、worktree、patch、Diff 和恢复点封装为一个模块：

```typescript
interface Workspace {
  prepare(input: WorkspaceSpec): Promise<WorkspaceHandle>;
  apply(handle: WorkspaceHandle, patch: Patch): Promise<ApplyResult>;
  inspect(handle: WorkspaceHandle): Promise<WorkspaceReport>;
  dispose(handle: WorkspaceHandle, outcome: 'keep' | 'discard'): Promise<void>;
}
```

实现约束：

- 从指定 commit 创建 worktree，不直接写源检出目录。
- 路径解析后必须位于 worktree 根目录。
- 默认禁止修改 `.git`、密钥文件和策略配置。
- 每次 patch 前后记录文件 hash；冲突返回结构化错误。
- `WorkspaceReport` 包含 diff、未跟踪文件、变更大小和可疑文件。

### 4.4 ExecutionSandbox

```typescript
interface ExecutionSandbox {
  exec(handle: WorkspaceHandle, request: ExecRequest): Promise<ExecResult>;
  terminate(runId: RunId): Promise<void>;
}
```

`ExecResult` 必须包含退出码、stdout/stderr 截断标志、时长、超时状态和资源使用量。生产使用 Docker adapter；测试使用受控的本地或内存 adapter。

### 4.5 PolicyEngine

PolicyEngine 是所有工具共享的强制 seam，不依赖模型自律：

```typescript
interface PolicyEngine {
  authorize(input: CapabilityRequest): Promise<PolicyDecision>;
}

type PolicyDecision =
  | { decision: 'allow'; constraints: RuntimeConstraints }
  | { decision: 'ask'; reason: string; requestedScope: ApprovalScope }
  | { decision: 'deny'; reason: string };
```

判定输入包括用户、项目、Run、工具、规范化参数、文件路径、网络域名和历史审批。优先级固定为：`deny > ask > allow`。

### 4.6 Verifier

```typescript
interface Verifier {
  verify(input: VerificationInput): Promise<VerificationReport>;
}
```

验证报告包含：

- 用户验收条件逐项状态
- 必需命令及其退出码
- 新增/修改测试结果
- typecheck、lint、build 结果
- Diff 风险检查
- 未验证项和剩余风险
- 最终结论：`passed | failed | inconclusive`

模型可以建议验证命令，但项目配置和系统策略决定最低验证集。

### 4.7 ContextAssembler

ContextAssembler 按预算构建模型输入，保持稳定信息不被摘要覆盖：

```typescript
interface ContextAssembler {
  build(input: ContextRequest): Promise<ModelContext>;
}
```

优先级从高到低：

1. 系统安全规则和工具语义
2. 原始用户任务、后续 steer 和验收条件
3. 项目与目录级指令
4. 当前计划、工作区状态、验证失败
5. 最近工具结果和相关文件片段
6. 历史事件摘要和可选记忆

禁止摘要替换原始任务、权限约束和验收条件。大型工具输出存为 Artifact，只向上下文注入带 hash 的摘要和引用。

### 4.8 Memory

首期记忆分为两类：

| 类型 | 作者 | 作用域 | 是否自动执行 |
|---|---|---|:---:|
| Project instruction | 人工/代码仓库 | 项目或目录 | 是，作为上下文而非权限 |
| Candidate memory | Agent 或用户 | 用户 + 项目 | 否，需可见、可编辑、可删除 |

候选记忆字段：来源 Run、证据、作用域、创建者、过期时间、状态和版本。任何记忆都不能覆盖 PolicyEngine。

### 4.9 ModelGateway

只有确实存在两个模型 adapter 时才建立该 seam。它负责：

- 统一结构化工具调用和流式事件
- 超时、重试和速率限制
- token、缓存命中和成本记录
- 模型能力校验
- 对厂商错误进行归一化

不承诺“换模型效果不退化”；每个模型必须运行同一黄金任务集。

首期配置确认如下：

- 默认模型：`gpt-5.6-terra`，`reasoning.effort=medium`，使用 Responses API。
- 高难任务：可申请升级到 `gpt-5.6-sol`；升级属于费用能力审批，不自动发生。
- MVP 不做跨供应商自动故障转移；Anthropic adapter 放在 Phase 3，并通过相同黄金任务后启用。
- 单次模型请求的输入预算默认不超过 240K tokens，避免无控制地扩大上下文和费用。
- 单 Run 默认费用预警为 1 美元、硬上限为 2 美元；管理员可按项目下调，不可由 Agent 上调。
- 单 Run 默认墙钟时间 30 分钟、最多 60 次工具调用、最多 3 次可重试模型错误。

模型与价格属于运行配置而不是代码常量；启动时记录实际 model id 和价格表版本。选型依据：[OpenAI 模型说明](https://developers.openai.com/api/docs/models)、[GPT-5.6 Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra)。

---

## 五、Agent 运行流程

```typescript
async function executeRun(runId: RunId): Promise<void> {
  const run = await runs.acquireLease(runId);
  const workspace = await workspaces.prepare(run.workspaceSpec);

  while (await budgets.canContinue(runId)) {
    await cancellations.throwIfRequested(runId);

    const context = await contexts.build({ runId, workspace });
    const response = await models.next(context);

    if (response.type === 'tool_calls') {
      for (const call of response.calls) {
        const decision = await policies.authorize({ runId, call });
        const result = await executeAccordingToPolicy(decision, call);
        await events.recordToolResult(runId, call, result);
      }
      continue;
    }

    if (response.type === 'request_user_input') {
      await runs.waitForUser(runId, response.request);
      continue;
    }

    if (response.type === 'candidate_finish') {
      const report = await verifier.verify({ runId, workspace });
      if (report.outcome === 'passed') {
        await runs.succeed(runId, report);
        return;
      }
      await events.recordVerification(runId, report);
    }
  }

  await runs.fail(runId, { reason: 'budget_exhausted' });
}
```

不向用户展示私有思维链。UI 展示简短进度说明、计划、工具调用、输出摘要、审批原因和验证证据。

反思不固定每五步触发，只在以下事件发生时触发策略调整：

- 相同错误重复出现
- 验证失败
- 连续多步没有工作区变化
- 工具连续失败
- token、时间或步骤预算接近阈值

---

## 六、工作区与沙箱

### 6.1 生命周期

```text
注册仓库 → 获取指定 commit → 创建 Run worktree → 建立初始快照
→ 挂载至沙箱可写工作目录 → 修改/执行/验证
→ 生成最终 Diff 和报告 → keep 或 discard → 清理容器
```

### 6.2 Docker 基线

- 容器进程使用非 root UID/GID。
- `--cap-drop=ALL`、`no-new-privileges`、只读根文件系统。
- worktree 作为唯一主要可写挂载；临时目录使用限额 tmpfs。
- 限制 CPU、内存、PID、文件大小、打开文件数和总执行时间。
- 不挂载 Docker socket、宿主 SSH 目录或应用环境变量。
- 镜像使用固定 digest，并持续更新和扫描。
- 命令参数采用结构化数组执行；需要 shell 时显式标记并提高权限等级。
- stdout/stderr 和文件读取均有字节上限，超限内容进入 Artifact。

### 6.3 网络策略

默认无网络。依赖安装等场景通过沙箱外代理申请域名级访问：

```text
deny: 私网地址、云元数据地址、任意 IP、未声明端口
ask:  新域名、Git 远端、包仓库以外的 HTTPS
allow: 项目预批准的 registry 域名和只读文档域名
```

审批展示域名、用途、有效期和风险；不把应用的 LLM API Key 注入沙箱。

---

## 七、权限与审批

### 7.0 两层审批模型

参考 Codex 的交互，系统区分两层：

1. **Run 级审批模式**：决定什么情况下需要弹出审批。
2. **单次审批决定**：弹出审批后，用户决定允许、拒绝、修改或取消。

Run 级审批模式提供三个选项：

| UI 名称 | 内部值 | 行为 | 可用阶段 |
|---|---|---|---|
| 请求批准 | `manual` | 文件修改、网络、敏感读取、高风险命令等按规则请求用户批准 | Phase 1，默认模式 |
| 替我审批 | `auto_review` | 低风险操作由独立风险审查器自动决定；不确定或高风险操作仍请求用户批准 | Phase 2，评测达标后开放 |
| 完全访问权限 | `full_access` | 在当前 Run 的专用 worktree 和沙箱内跳过交互审批 | Phase 2，仅管理员和隔离环境 |

这三个模式只改变“是否需要交互询问”，不能绕过系统硬限制。以下操作在所有模式下仍固定 deny：

- 访问其他用户或项目的工作区
- 读取宿主机凭证、SSH 私钥、浏览器数据或系统钥匙串
- 访问 Docker socket、创建新宿主挂载或提升容器 capability
- 访问环回、私网、链路本地和云元数据地址
- 修改 PolicyEngine、审计日志或系统安全配置
- 超出费用、时间、并发和资源硬上限

审批模式与文件访问范围分开建模：

| 文件访问范围 | 内部值 | 可用环境 | 含义 |
|---|---|---|---|
| 工作区 | `workspace_only` | 服务器、PC | 仅当前 worktree，默认 |
| 选定目录 | `selected_directories` | PC Local Runner | 仅用户通过系统目录选择器授权的目录 |
| 整台电脑 | `host_full` | PC Local Runner | 可访问当前用户权限范围内的本机文件，极高风险 |

在服务器环境中，“完全访问权限”只代表当前隔离工作区内跳过交互审批，不代表宿主机无限制访问。

Phase 4B 的本地可信 Runner 可以提供与 Codex 类似的“整台电脑”选项，但必须满足：用户在 OS 原生界面二次确认、只对当前 Run 生效、醒目显示持续状态、支持一键降权/中止、记录所有工作区外访问；管理员可通过组织策略完全禁用。即使选择 `host_full`，跨用户账户、系统完整性保护区域、原始密钥回传、审计篡改和预算突破仍固定 deny。

#### `auto_review` 的约束

- 先执行确定性的 allow/deny 规则，再调用独立风险审查器；不能让执行任务的同一个模型自行批准自己的请求。
- 风险审查器只可在 `allow` 与 `ask` 之间选择，不能覆盖固定 deny。
- 输入包含规范化能力、目标、命令段、Diff 摘要、网络端点、项目规则和用户原始任务。
- 输出必须包含决定、风险等级、理由、规则版本和审查模型版本，并写入审计日志。
- 误放行率未通过对抗评测前，`auto_review` 不得成为默认模式。

```typescript
type ApprovalMode = 'manual' | 'auto_review' | 'full_access';

interface ApprovalProfile {
  mode: ApprovalMode;
  fileAccessScope: 'workspace_only' | 'selected_directories' | 'host_full';
  runId: RunId;
  projectId: ProjectId;
  selectedBy: UserId;
  selectedAt: string;
}
```

### 7.1 能力分类

| 能力 | 默认 | 示例 |
|---|---|---|
| 只读工作区 | allow | 搜索、读取普通源码 |
| 修改工作区 | allow/ask 可配置 | apply patch |
| 普通构建测试 | allow | `npm test`、`pytest` |
| 网络访问 | ask | 安装依赖、访问 Git 远端 |
| 工作区外读写 | deny | 用户目录、系统目录 |
| Git 提交与推送 | ask / MVP 禁用 | commit、push |
| 外部系统写入 | deny | 发消息、部署、建 PR |
| 密钥与凭证文件 | deny | `.env`、SSH keys |

敏感能力使用统一分类，不针对自由文本命令做模糊授权：

| 能力类型 | 审批对象 | 约束维度 |
|---|---|---|
| `sensitive_file_read` | 规范化后的真实路径 | read、文件 hash、Run、是否跟随软链接 |
| `protected_file_write` | 真实路径与 patch 摘要 | write、变更大小、目标文件 |
| `command_exec` | 解析后的单个命令段 | argv、cwd、环境变量名、路径、shell 模式 |
| `network_egress` | 目标端点 | scheme、domain、port、用途、有效期 |
| `secret_use` | 密钥别名 | 允许注入给哪个工具/域名，不显示密钥值 |
| `external_write` | 外部系统动作 | 系统、对象、动作、预览内容 |
| `model_upgrade` | 更高成本模型 | model id、预计增量费用、本 Run |

### 7.2 审批范围

当 `manual` 或 `auto_review` 决定需要询问用户时，审批 UI 支持以下决定：

| 决定 | 含义 | MVP |
|---|---|:---:|
| `allow_once` | 仅允许当前 `tool_call_id` | ✅ |
| `allow_for_run` | 当前 Run 内允许相同能力指纹 | ✅ |
| `edit_and_allow_once` | 用户缩小路径、命令或域名后仅执行一次 | ✅ |
| `deny_once` | 拒绝本次调用，并把原因反馈给 Agent | ✅ |
| `deny_for_run` | 当前 Run 内阻止相同能力指纹 | ✅ |
| `cancel_run` | 拒绝并中止整个 Run | ✅ |
| `allow_for_project` | 保存项目级规则 | ✅，仅项目管理员 |
| `deny_for_project` | 保存项目级强制拒绝规则 | ✅，仅项目管理员 |

能力指纹必须包含规范化参数，不能只包含工具名称。例如命令指纹至少包含 `argv + cwd + shellMode`；网络指纹至少包含 `scheme + domain + port`；文件指纹至少包含 `operation + realpath`。

不同能力允许的最大审批范围：

| 能力 | 一次 | 当前 Run | 项目级允许 | 项目级拒绝 |
|---|:---:|:---:|:---:|:---:|
| 普通受保护文件写入 | ✅ | ✅ | ✅，精确路径/窄 glob | ✅ |
| 可申请的敏感文件读取 | ✅ | ✅，绑定 hash | ❌ | ✅ |
| 凭证、SSH、钥匙串原文读取 | ❌ | ❌ | ❌ | 固定 deny |
| 普通命令 | ✅ | ✅，精确能力指纹 | ✅，管理员窄前缀 | ✅ |
| Shell 动态命令 | ✅，修改后执行 | ❌ | ❌ | ✅ |
| 网络域名访问 | ✅ | ✅ | ✅，管理员域名规则 | ✅ |
| 密钥别名使用 | ✅ | ✅，限定工具和域名 | ❌ | ✅ |
| 模型升级 | ✅ | ✅ | ✅，管理员费用策略 | ✅ |
| 外部写操作 | ✅，未来版本 | ❌ | ❌ | ✅ |

项目级规则由管理员显式创建并可在设置页撤销。Agent 可以说明为什么需要权限，但不能决定规则作用域，也不能自动创建宽泛前缀规则。

#### 命令审批

- 优先以 `argv[]` 直接执行，不经过 shell。
- 使用 shell 时，将管道、`&&`、`||`、`;`、子 shell 和命令替换拆成独立命令段逐段授权。
- 含无法静态解析的通配符、重定向、动态环境变量或命令替换时，不允许复用 `allow_for_run`，只能修改后批准一次或拒绝。
- `sudo`、修改系统配置、访问 Docker socket、挂载新宿主路径始终 deny。
- 项目级命令前缀规则只允许管理员手工创建，且必须是窄前缀，如 `npm test`，不得使用 `bash`、`python` 等通用解释器作为前缀。

#### 本机文件与敏感数据审批

- 普通源码的工作区内读取默认 allow；`.env`、凭证、SSH、浏览器配置、系统钥匙串和工作区外文件默认 deny。
- 对可申请读取的敏感文件，审批卡片只先展示规范化路径、大小、类型和请求原因，不在批准前展示内容。
- 批准绑定文件 hash；文件变化后必须重新审批，避免批准后替换内容。
- 密钥只以别名形式注入指定工具进程，并限定目标域名；Agent、事件流和日志都看不到原始值。

#### 网络审批

- 审批绑定 `scheme + domain + port`，不批准任意 IP 或整个互联网。
- 代理解析 DNS 后阻断环回、私网、链路本地和云元数据地址，防止 DNS rebinding/SSRF。
- 默认可申请的依赖域名包括 `registry.npmjs.org`、`pypi.org`、`files.pythonhosted.org`；首次访问仍按项目策略 ask。
- HTTP 非 TLS、非常用端口、上传请求和新域名显示高风险，不支持静默永久允许。
- 下载内容记录来源 URL、hash 和大小；超限或重定向到未批准域名时停止。

#### 外部写操作审批

MVP 默认关闭 push、PR、部署、发送消息和修改工单。未来启用时必须展示完整动作预览，并且只支持 `allow_once`，不允许普通用户永久批准。

### 7.3 审计

记录原始请求、规范化能力、PolicyDecision、批准人、批准范围、执行结果和关联事件。日志中的密钥、token 和敏感环境变量必须脱敏。

审批卡片至少展示：风险等级、Agent 请求原因、精确目标、将读取/修改/发送什么、有效范围、可撤销方式和预计费用。所有审批决定写入不可由 Agent 修改的审计记录。

---

## 八、持久化模型

核心关系：

```text
User ──< ProjectMembership >── Project ──< Run ──< RunEvent
                                      │       ├──< Approval
                                      │       ├──< Artifact
                                      │       └──  VerificationReport
                                      └──< ProjectMemory
```

建议表：

```sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  repo_url TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE project_memberships (
  project_id TEXT NOT NULL REFERENCES projects(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('viewer', 'developer', 'admin')),
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  public_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE execution_environments (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT REFERENCES users(id),
  device_id TEXT REFERENCES devices(id),
  target_type TEXT NOT NULL,
  capabilities JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  base_commit TEXT NOT NULL,
  environment_id TEXT NOT NULL REFERENCES execution_environments(id),
  task TEXT NOT NULL,
  acceptance_criteria JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  approval_mode TEXT NOT NULL DEFAULT 'manual',
  version INTEGER NOT NULL DEFAULT 0,
  worker_id TEXT,
  lease_expires_at TIMESTAMPTZ,
  cancel_requested_at TIMESTAMPTZ,
  token_usage JSONB NOT NULL DEFAULT '{}',
  cost_amount NUMERIC(12, 6) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE run_events (
  id BIGSERIAL PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  sequence_num BIGINT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, sequence_num)
);

CREATE TABLE tool_calls (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  tool_name TEXT NOT NULL,
  normalized_input JSONB NOT NULL,
  status TEXT NOT NULL,
  result_summary JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  tool_call_id TEXT NOT NULL REFERENCES tool_calls(id),
  status TEXT NOT NULL,
  capability_type TEXT NOT NULL,
  capability_hash TEXT NOT NULL,
  reason TEXT NOT NULL,
  scope TEXT,
  decision TEXT,
  constraints JSONB NOT NULL DEFAULT '{}',
  decided_by TEXT REFERENCES users(id),
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  kind TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  byte_size BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE project_memories (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  created_by TEXT NOT NULL,
  source_run_id TEXT REFERENCES runs(id),
  content TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'candidate',
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

原始命令输出和大文件不进入 `run_events`，存入对象存储或本地 Artifact 目录并使用 hash 校验。

---

## 九、HTTP 与事件契约

面向 Web、PC 客户端和未来 CLI 的公共契约从首版使用 `/api/v1`，并由 `packages/contracts` 生成 TypeScript Client SDK。事件只允许向后兼容地增加字段；删除、重命名或改变语义必须发布新版本。

| 路径 | 方法 | 用途 |
|---|---|---|
| `/api/v1/projects` | GET/POST | 列出或注册项目 |
| `/api/v1/projects/:id/runs` | POST | 创建 Run，提交 `environmentId`、`approvalMode` 和文件范围，返回 `202 + runId` |
| `/api/v1/runs/:id` | GET | 获取当前状态与汇总 |
| `/api/v1/runs/:id/events` | GET | SSE 订阅持久化事件，支持 `Last-Event-ID` |
| `/api/v1/runs/:id/commands` | POST | cancel、steer、answer、降低权限 |
| `/api/v1/runs/:id/approvals/:approvalId` | POST | 批准或拒绝 |
| `/api/v1/runs/:id/diff` | GET | 获取最终或当前 Diff |
| `/api/v1/runs/:id/verification` | GET | 获取验证报告 |
| `/api/v1/runs/:id/result` | POST | keep 或 discard 工作区结果 |
| `/api/v1/projects/:id/memories` | GET/POST/PATCH | 管理项目记忆 |
| `/api/v1/devices/code` | POST | 创建一次性设备绑定码 |
| `/api/v1/devices/exchange` | POST | PC 客户端交换短期设备凭证 |
| `/api/v1/environments` | GET | 列出服务器和在线 Local Runner |

Local Runner 与控制面使用单独的版本化 WSS 协议：

```text
wss://<server>/runner/v1/connect
```

- Runner 仅建立出站连接，使用设备私钥完成 challenge-response。
- 每条命令包含 `messageId/runId/environmentId/sequence/expiry/signature`。
- Runner 对重复 `messageId` 返回既有结果，不再次执行。
- 断线重连携带最后确认的事件序号；服务端补发未确认命令。
- 控制面不能任意调用本机 Shell，只能发送 contracts 中定义的 `EnvironmentAction`。

事件示例：

```json
{ "seq": 18, "type": "progress", "data": { "summary": "正在运行用户模块测试" } }
{ "seq": 19, "type": "tool_started", "data": { "callId": "tc_1", "tool": "exec" } }
{ "seq": 20, "type": "approval_required", "data": { "approvalId": "ap_1", "reason": "需要访问 registry.npmjs.org" } }
{ "seq": 21, "type": "verification", "data": { "outcome": "failed", "failedChecks": ["npm test"] } }
{ "seq": 22, "type": "run_completed", "data": { "status": "succeeded", "reportId": "vr_1" } }
```

---

## 十、安全威胁模型

| 威胁 | 主要控制 |
|---|---|
| 仓库提示注入 | 项目内容视为不可信数据；权限由 PolicyEngine 强制 |
| 路径穿越与软链接逃逸 | realpath 校验、拒绝越过 worktree、敏感路径 deny |
| 任意命令绕过黑名单 | 能力策略 + OS 隔离，不以字符串黑名单作为主控制 |
| 网络数据外传 | 默认断网、域名代理、私网/IP 禁止、请求审计 |
| Docker daemon 逃逸 | Web 不直接持有 socket；专用 Worker；最小宿主权限 |
| 资源耗尽 | CPU/内存/PID/磁盘/时长/token/并发配额 |
| 日志泄密 | 输出脱敏、Artifact 访问控制、保留周期 |
| 跨用户项目访问 | 每个查询强制 project membership，禁止仅凭 ID 访问 |
| 重试重复副作用 | tool call 幂等键，外部写操作默认禁用 |
| 记忆污染 | 项目作用域、来源、候选状态、人工编辑与删除 |
| `full_access` 被误用 | 仅管理员、仅隔离 Run、醒目警告、不可绕过固定 deny |
| PC Renderer 被 XSS/RCE | 只加载签名的本地资源、禁用 Node integration、context isolation、sandbox、严格 CSP |
| Desktop IPC 越权 | 窄 preload interface、校验 sender、参数 schema、禁止透传任意 IPC/Shell |
| Local Runner 凭证被盗 | 设备密钥放 OS keychain、短期令牌、设备撤销、签名 challenge |
| 桌面更新供应链攻击 | Windows/macOS 代码签名、macOS notarization、签名更新清单、可回滚发布 |
| 供应链风险 | 镜像 digest、依赖锁、镜像扫描、受控 registry |

上线前必须进行针对路径、软链接、命令组合、网络、输出炸弹、容器逃逸和跨项目 IDOR 的专项测试。

### 10.1 PC 客户端技术与安全基线

PC 客户端默认采用 Electron + React + Electron Forge，以复用 TypeScript、React、contracts 和 Client SDK。若后续安装包体积成为关键指标，可在不改变 contracts 和 Local Runner 的前提下评估 Tauri shell。

Electron 必须满足：

- Renderer 只加载安装包内的本地 UI，不直接加载服务器网页或任意远程页面。
- `nodeIntegration=false`、`contextIsolation=true`、Renderer sandbox 开启。
- 使用严格 CSP，禁止任意导航、新窗口、未验证的外部链接和 `<webview>`。
- preload 只暴露逐方法、强类型、参数校验后的窄 interface；不得暴露 `ipcRenderer`、文件系统、进程或 Shell 通用能力。
- Desktop Main 校验每个 IPC sender、Run 归属和用户授权。
- Local Runner 是独立签名进程，通过 Unix domain socket 或 Windows named pipe 通信；通道使用随机会话密钥并限制为当前用户。
- OAuth/设备 token、设备私钥和密钥别名放入 Windows Credential Manager 或 macOS Keychain，不写入普通配置文件。
- Windows 与 macOS 安装包必须代码签名；macOS 还需 notarization。自动更新只接受签名清单和签名包。

安全依据：[Electron Security Checklist](https://www.electronjs.org/docs/latest/tutorial/security)、[Context Isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation)、[Process Sandboxing](https://www.electronjs.org/docs/latest/tutorial/sandbox)、[Packaging and Code Signing](https://www.electronjs.org/docs/latest/tutorial/tutorial-packaging)。

---

## 十一、可观测性与成本

每个 Run 记录：

- 模型、输入/输出/缓存 token 和费用
- 工具调用数量、失败率、耗时和输出截断
- Run 各状态停留时间
- 审批次数、等待时间和拒绝率
- worktree 创建、清理和残留情况
- 验证命令、结论和失败原因
- 用户 steer、中止、keep/discard

配额：

- 单 Run 最大费用、token、墙钟时间、工具调用数和重试数
- 单用户/项目并发 Run 数
- 每日团队预算告警和硬上限

“100 步不崩”不是质量指标。长任务应以任务通过率、成本、无进展步数和人工接管率评估。

---

## 十二、目录结构

```text
ai-coding-agent/
├── apps/
│   ├── web/                         # Next.js UI 与 HTTP/SSE
│   ├── worker/                      # 持久化 Run Worker
│   ├── desktop/                     # Phase 4 Electron UI 与 Desktop Main
│   └── local-runner/                # Phase 4 本机执行进程
├── packages/
│   ├── run-engine/                  # RunEngine 深模块
│   ├── run-environment/             # RunEnvironment port 与 adapters
│   ├── workspace/                   # worktree、patch、diff、清理
│   ├── execution-sandbox/           # ExecutionSandbox + Docker adapter
│   ├── policy/                      # PolicyEngine 与规则
│   ├── verifier/                    # 验收与验证报告
│   ├── context/                     # ContextAssembler
│   ├── memory/                      # 项目指令与候选记忆
│   ├── model-gateway/               # 模型 adapter 与用量
│   ├── persistence/                 # schema、repositories、queue
│   ├── contracts/                   # 跨进程事件和命令类型
│   ├── client-sdk/                  # Web/PC/未来 CLI 共用的版本化 SDK
│   └── test-harness/                # fake adapters、黄金任务运行器
├── docker/
│   ├── sandbox.Dockerfile
│   ├── worker.Dockerfile
│   └── web.Dockerfile
├── evals/
│   ├── tasks/                       # 黄金任务定义
│   └── fixtures/                    # 固定测试仓库
├── docs/
│   ├── threat-model.md
│   ├── run-state-machine.md
│   └── operations.md
├── docker-compose.yml
└── package.json
```

模块测试通过各自 interface，使用测试 adapter 替换 PostgreSQL、模型、文件系统或 Docker。避免为 Planner、Reflector 等内部实现细节建立外部 interface。

---

## 十三、分阶段实施计划

### Phase 0：风险验证与评测基线（1 周）

| 任务 | 退出条件 |
|---|---|
| 建立 20 个黄金任务 | 每个任务有固定仓库、验收条件和验证命令 |
| Docker 威胁模型 PoC | 证明路径、资源、网络和非 root 限制可执行 |
| worktree PoC | 并行 Run 不修改主检出目录 |
| 模型 PoC | 至少一个模型可稳定输出结构化工具调用 |
| 成本基线 | 记录 5 个代表任务的费用和时长 |
| 客户端兼容契约 | `/api/v1`、事件 envelope、RunEnvironment 和 Client SDK 类型通过契约测试 |

### Phase 1：单用户可靠闭环（2–3 周）

| 任务 | 退出条件 |
|---|---|
| RunEngine + Worker | 浏览器断线后 Run 继续，重启后可恢复 |
| Workspace | 创建 worktree、apply patch、生成 Diff、discard |
| ExecutionSandbox | 执行测试且满足资源和路径约束 |
| 基础 PolicyEngine | 文件与命令能力可 allow/ask/deny |
| `manual` 审批模式 | 敏感能力可阻塞、批准、拒绝并恢复 Run |
| Verifier | 模型 finish 后必须通过验证才能 succeeded |
| Web UI | 展示进度、Diff、验证证据和取消操作 |
| Client SDK | Web 不直接拼接 HTTP/SSE，所有调用通过版本化 SDK |

验收：至少 12/20 个黄金任务一次运行验证通过；所有结果都可丢弃且不污染源仓库。

### Phase 2：多用户与生产加固（2–3 周）

| 任务 | 退出条件 |
|---|---|
| 登录和项目 membership | 跨项目 IDOR 测试全部阻断 |
| 审批流 | 网络和高风险能力可批准、拒绝并恢复 Run |
| `auto_review` 与 `full_access` | 对抗评测通过；固定 deny 在三种模式下均不可绕过 |
| 租约、心跳和幂等 | Worker 中断后无重复副作用地接管 |
| Artifact 和脱敏 | 大输出不撑爆数据库，敏感值不进入日志 |
| 配额与监控 | token、费用、时间、并发均可限制 |
| 安全测试 | 越权写、路径逃逸、网络外传用例通过 |

### Phase 3：项目适配与开发体验（2 周）

| 任务 | 退出条件 |
|---|---|
| `AGENTS.md` / `CLAUDE.md` | 指令按项目和目录作用域加载 |
| 验证配置 | 项目可声明 test/typecheck/lint/build 最低集合 |
| steer 与输入请求 | 用户可在 Run 中追加约束或回答问题 |
| 第二模型 adapter | 通过同一黄金任务和事件契约 |
| 运维文档 | 新部署者可完成备份、恢复、升级和清理 |

### Phase 4：PC 客户端与扩展生态

#### Phase 4A：Connected Desktop（2–3 周）

| 任务 | 退出条件 |
|---|---|
| Electron + React shell | Windows/macOS 可安装，复用 Client SDK 和核心 UI |
| 设备绑定 | 浏览器完成身份验证，设备可查看和撤销 |
| Run 管理 | 创建、恢复、中止、审批、Diff、验证与 Web 行为一致 |
| 安全基线 | nodeIntegration 关闭、context isolation、sandbox、CSP 和 IPC 测试通过 |
| 发布链路 | Windows/macOS 签名构建；macOS notarization；更新签名验证 |

#### Phase 4B：Local Runner（3–5 周）

| 任务 | 退出条件 |
|---|---|
| DesktopLocalEnvironment | 通过与 ServerDockerEnvironment 相同的 interface 契约测试 |
| 本地 worktree/sandbox | 不污染原仓库，支持 keep/discard、取消和恢复 |
| Runner WSS | 断线重连、消息去重、设备撤销和事件续传通过 |
| 文件范围 | workspace、selected directories、host full 三档行为与审批一致 |
| 本机权限安全 | Renderer 无直接本机能力；Local Runner 记录工作区外访问 |

其余扩展按需求进入后续版本：

- MCP、skills 和生命周期 hooks
- Commit、branch、PR 与代码审查
- 多 Agent 与独立子 worktree
- CLI 或 IDE 接入

### Phase 5：受控记忆优化（有足够数据后）

进入条件：至少数百个带 `verified + user accepted` 标签的 Run，并有稳定黄金任务回归。

- 生成候选经验，不直接修改系统提示词
- 离线对照评测和置信区间
- 人工批准、版本化、灰度和回滚
- 按项目、框架、模型版本分层统计

---

## 十四、主要风险与应对

| 风险 | 概率 | 影响 | 应对 |
|---|:---:|:---:|---|
| 模型工具行为不稳定 | 高 | 高 | 结构化调用、错误归一化、黄金任务回归 |
| Docker 隔离配置错误 | 中 | 高 | 威胁模型、专用 Worker、最小权限和专项测试 |
| 任务恢复产生重复执行 | 中 | 高 | 事件日志、租约、call_id、幂等边界 |
| 仓库构建需要复杂网络 | 高 | 中 | 受控代理、依赖缓存、项目级预批准域名 |
| 单机资源不足以支持 5 并发 | 中 | 中 | Phase 0/2 压测、队列背压、动态并发 |
| token 费用超预算 | 中 | 高 | 单 Run 硬上限、缓存、模型分级和预算看板 |
| 摘要丢失关键约束 | 中 | 高 | 不压缩原始任务/验收/权限；Artifact 引用 |
| 项目记忆污染 | 中 | 中 | 候选状态、来源、作用域、过期和人工管理 |
| 技术版本快速过期 | 高 | 低 | 兼容矩阵、锁文件、定期升级回归 |
| 单人开发周期低估 | 高 | 中 | Phase 0 先验证难点，每阶段独立交付 |

---

## 十五、已确认的开工决策

### 15.1 仓库与凭证

- MVP 只支持服务器上已克隆并由管理员注册的本地 Git 仓库。
- 用户不能提交任意本机路径；管理员注册时解析真实路径并建立项目记录。
- MVP 不接收用户 Git 密码、SSH 私钥或 Personal Access Token。
- 拉取远端、clone、push 和 PR 均不进入 MVP；需要更新基线时由管理员在 Agent 系统外完成。

### 15.2 结果交付

- Run 在独立 worktree 中修改代码。
- `keep`：生成带 SHA-256 的 patch、Diff 与 VerificationReport，并保留 worktree 7 天。
- `discard`：立即清理 worktree；审计与验证元数据按保留策略继续保存。
- MVP 由用户下载 patch 后使用 `git apply`，或在服务器上人工检查后应用。
- 自动 commit、cherry-pick、push 和 PR 放到 Phase 4。

### 15.3 Worker 与队列

- Web 和 Worker 是独立进程，使用同一 PostgreSQL。
- 队列采用 `pg-boss`；只传递 `runId`，不把完整任务上下文复制进队列负载。
- `runs/run_events` 是业务事实来源；队列状态不能替代 Run 状态机。
- 所有工具调用继续使用稳定 `call_id`，因为重试并不等于绝对只处理一次。

### 15.4 Docker 部署

- Web 进程不访问 Docker socket。
- 专用 Worker 连接专用 rootless Docker daemon；生产优先部署在独立沙箱主机或 VM。
- 若 Phase 0 暂时同机运行，Worker 使用独立系统用户、固定 worktree 根目录和受限 socket；不得把 `/var/run/docker.sock` 挂给 Web 容器。
- 容器创建参数由 ExecutionSandbox 固定生成，模型不能提交镜像、挂载、capability 或网络模式。

### 15.5 模型与预算

- 默认模型：`gpt-5.6-terra`，medium reasoning。
- `gpt-5.6-sol` 仅用于明确批准的高难任务；按 `model_upgrade` 能力审批。
- 默认单 Run：1 美元预警、2 美元硬上限、30 分钟墙钟时间、60 次工具调用。
- 单次请求默认最多 240K 输入 tokens；项目管理员只能下调普通用户上限，团队管理员才能上调。
- 团队月度硬预算为 3000 元人民币等值；达到 80% 告警，达到 100% 停止新 Run。

### 15.6 项目验证配置

项目使用人工维护的 `.ai-agent/project.yaml`：

```yaml
version: 1
verify:
  required:
    - npm test
    - npm run typecheck
  optional:
    - npm run lint
network:
  askDomains:
    - registry.npmjs.org
protectedPaths:
  - .env
  - .github/workflows/**
```

- 配置进入 Git 并参与评审。
- Agent 可以建议修改该文件，但修改本身属于 `protected_file_write`，必须人工批准。
- Verifier 必须执行所有 `required` 命令；Agent 自行增加的命令只能补充，不能替代。

### 15.7 认证与保留策略

- 使用 Auth.js + GitHub OAuth；只允许管理员配置的 GitHub 组织或邮箱白名单登录。
- 项目访问仍由 `project_memberships` 决定，成功登录不自动获得仓库权限。
- worktree 和大型 Artifact：默认 7 天；`discard` 的 worktree 立即清理。
- Run 事件和普通日志：30 天。
- 审批审计、VerificationReport、Diff hash 和费用汇总：180 天。
- 原始密钥永不持久化；脱敏后的密钥别名和使用审计保留 180 天。
- 每日清理任务必须记录删除数量、失败项和残留路径。

认证实现参考：[Auth.js 官方 GitHub provider 示例](https://authjs.dev/)。

### 15.8 审批模式

- Phase 1 默认并只开放 `manual`（请求批准）。
- Phase 2 在风险审查对抗评测通过后开放 `auto_review`（替我审批）。
- 服务器环境的 `full_access` 仅项目管理员可选择；PC Local Runner 中，设备所有者可在组织策略允许时为自己的设备选择，只对单个 Run 生效。
- `full_access` 仍受 worktree、容器、项目隔离、网络禁区、敏感凭证禁区和资源配额约束。
- 每个 Run 固化创建时的审批模式；运行中升级权限必须重新确认，降级到更严格模式可立即生效。

### 15.9 PC 客户端适配要求

- 后续必须交付 Windows 与 macOS PC 客户端；Windows 优先，Linux 不作为首期桌面交付目标。
- Phase 4A 先提供服务器连接模式，Phase 4B 再提供 Local Runner。
- 桌面端采用 Electron + React，复用 `packages/contracts`、`packages/client-sdk` 和可共享 UI；不复制 RunEngine。
- 服务器执行与本机执行分别实现 `ServerDockerEnvironment`、`DesktopLocalEnvironment` 两个 adapter。
- PC 客户端支持与 Web 一致的三种审批模式，并在 Local Runner 中增加 `workspace_only / selected_directories / host_full` 文件范围。
- Local Runner、设备绑定、代码签名、自动更新和 OS keychain 属于桌面客户端的发布阻断项。

---

## 十六、结论

方案 A 的 TypeScript、Web-first 和自建执行环境仍然适合当前团队规模，但实现重点必须从“复杂 Loop 和自我进化”转向“可靠 Harness”。

建议批准 Phase 0，不一次性批准全部五阶段。Phase 0 完成后，用以下证据决定是否进入 Phase 1：

- worktree 与沙箱 PoC 可行
- 黄金任务和验证方式明确
- 单任务成本处于预算范围
- 持久化 Run 状态机没有关键未知项
- 威胁模型中的高风险项存在可实施控制

本设计不声称在首期达到 Claude Code 或 Codex 的完整产品能力；其目标是在小团队场景下先交付一个可验证、可恢复、可审计、可逐步扩展的 Coding Agent 核心。

PC 客户端要求不会阻塞 Phase 0–3，但版本化 contracts、Client SDK 和 RunEnvironment seam 必须从 Phase 0 开始建立，否则 Phase 4 会被迫重写 Web 与 Worker 的调用关系。

---

## 附录：竞品依据

详细对标与官方来源见同目录《竞品官方资料研究笔记.md》。关键参考：

- [Claude Code Overview](https://code.claude.com/docs/en/overview)
- [Claude Code Permissions](https://code.claude.com/docs/en/permissions)
- [Claude Code Sandboxing](https://code.claude.com/docs/en/sandboxing)
- [Claude Code Memory](https://code.claude.com/docs/en/memory)
- [Claude Code Subagents](https://code.claude.com/docs/en/sub-agents)
- [OpenAI Codex CLI](https://learn.chatgpt.com/docs/codex/cli)
- [OpenAI Codex AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
- [OpenAI Codex Worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees)
- [OpenAI Codex App Server](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)

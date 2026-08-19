# AI Coding Agent — PRD 与技术设计方案书

> **项目代号**：ai-coding-agent  
> **复杂度**：M 级（多用户 + 多外部系统集成 + 自我进化）  
> **交付等级**：方案设计稿 v2（含自我进化能力，尚未实现，待用户批准后进入开发）  
> **日期**：2026-08-18  
> **版本**：v2.0 — 在 v1 基础上增加元级 Loop（跨会话自我进化）

---

## 一、需求基线（PRD）

### 1.1 产品目标

开发一个类似 Claude Code / Codex 的 AI 编程 Agent 系统。用户用自然语言描述编程任务，Agent 自主完成**拆解 → 执行 → 验证 → 修正**的闭环，输出可运行的代码。

### 1.2 目标用户与规模

| 维度 | 值 |
|------|-----|
| 用户画像 | 小团队开发者（5-20 人），有编程基础 |
| 月活规模 | ~20 人 |
| 峰值并发 | ~5 个会话同时活跃 |
| 运维能力 | 低（1 人开发兼运维） |

### 1.3 成功判据

> 能端到端完成一个中等复杂度的编程任务（如：给现有项目添加一个带测试的 CRUD 接口），全程无需人工干预，生成的代码可运行且通过测试。

### 1.4 核心功能范围（MVP）

| 功能 | 是否进 MVP | 理由 |
|------|:---------:|------|
| 多轮对话 + ReAct 循环 | ✅ | Agent 的最小骨架，不可省 |
| 工具调用：文件读写 | ✅ | 编程任务的基础能力 |
| 工具调用：代码执行 | ✅ | 验证生成代码是否可运行 |
| 工具调用：终端命令 | ✅ | 安装依赖、跑测试、git 操作 |
| 上下文管理（压缩/截断） | ✅ | 长任务不崩的必要条件 |
| 状态持久化（会话恢复） | ✅ | 多用户系统的基本要求 |
| 安全沙箱隔离 | ✅ | 执行用户代码不能裸跑在宿主机 |
| 多用户认证 | ✅ | 5-20 人使用的基本前提 |
| Loop 自主循环 | ✅ | 区别于"一问一答"的核心价值 |
| 经验记忆库（跨会话学习） | ✅ | 自我进化的基础——任务结束后存经验，新任务开始时检索注入 |
| 策略评分器 | ✅ | 追踪"什么策略对什么任务有效"，优先选高成功率策略 |
| Prompt 进化机制 | ✅ | 系统提示词从静态变动态，根据经验自动补充规则 |
| 元级 Loop 调度器 | ✅ | 定期回顾历史会话→提取模式→更新知识库 |
| 多 Agent 协作 | ❌ 延后 | MVP 先做单 Agent 闭环 |
| 代码审查 / PR 自动提交 | ❌ 延后 | 先验证核心闭环，再接协作流 |
| 自定义工具插件 | ❌ 延后 | 先用固定工具集验证 |
| 工具自创建（Agent 自己写新工具） | ❌ 延后 | Phase 5+ 可选扩展 |
| Web 可视化界面 | ✅ | 多用户需要 Web 入口 |
| CLI 客户端 | ❌ 延后 | 先做 Web，CLI 后补 |

### 1.5 非目标（明确不做）

- 不做模型训练 / 微调（直接用云端 LLM API）
- 不做多租户 SaaS（只服务一个团队）
- 不做 IDE 插件（先做独立 Web 应用）
- 不做实时协作编辑（非 Google Docs 式协同）
- 不做 Agent 自动写新工具（Phase 5+ 可选扩展，当前用固定工具集 + 经验规则）

### 1.6 硬约束

- 无数据出境 / 等保 / 内网部署等合规约束
- 可使用云端 LLM API（OpenAI / Claude / 国产大模型）
- 月预算上限 ~3000 元（含 LLM API 调用费）
- 团队 1 人，熟悉 TypeScript + Python，运维能力低

---

## 二、候选方案 ADR（两套对比）

### 方案 A：TypeScript 全栈（Node.js + Next.js + Docker 沙箱）

```
┌─────────────────────────────────────────────────────┐
│                    Next.js 全栈                       │
│  ┌──────────┐  ┌───────────┐  ┌──────────────────┐  │
│  │ Web UI   │  │ API Routes│  │  Agent Runtime    │  │
│  │ (React)  │  │ (Server)  │  │  (Loop + Harness) │  │
│  └──────────┘  └───────────┘  └────────┬─────────┘  │
│                                         │             │
│  ┌──────────┐  ┌───────────┐  ┌────────▼─────────┐  │
│  │ Auth     │  │ SQLite/PG │  │ Docker Sandbox   │  │
│  │ (NextAuth)│  │ (会话存储)  │  │ (代码执行隔离)    │  │
│  └──────────┘  └───────────┘  └──────────────────┘  │
│                  LLM API (OpenAI/Claude)              │
└─────────────────────────────────────────────────────┘
```

| 组件 | 技术选型 | 版本 |
|------|---------|------|
| 运行时 | Node.js | 20 LTS |
| Web 框架 | Next.js (App Router) | 15.x |
| 前端 | React + TailwindCSS | 19.x / 4.x |
| 数据库 | SQLite (开发) / PostgreSQL (生产) | 16.x |
| 沙箱 | Docker API (dockerode) | 27.x |
| LLM SDK | Vercel AI SDK | 4.x |
| 认证 | NextAuth.js | 5.x |
| 部署 | Docker Compose | — |

### 方案 B：Python 后端 + React 前端 + E2B 沙箱

```
┌─────────────────────────────────────────────────────┐
│  ┌──────────┐     ┌──────────────┐                  │
│  │ React SPA│────→│ FastAPI      │                  │
│  │ (Vite)   │     │ (Python)     │                  │
│  └──────────┘     └──────┬───────┘                  │
│                          │                          │
│          ┌───────────────┼───────────────┐          │
│          │               │               │          │
│   ┌──────▼─────┐  ┌──────▼──────┐  ┌─────▼──────┐  │
│   │ Agent Core │  │ PostgreSQL  │  │ E2B Sandbox │  │
│   │ (Loop)     │  │ (会话存储)   │  │ (云端沙箱)   │  │
│   └────────────┘  └─────────────┘  └────────────┘  │
│              LLM API (OpenAI/Claude)                 │
└─────────────────────────────────────────────────────┘
```

| 组件 | 技术选型 | 版本 |
|------|---------|------|
| 运行时 | Python | 3.12 |
| Web 框架 | FastAPI | 0.115.x |
| 前端 | React + Vite + TailwindCSS | 19.x / 6.x / 4.x |
| 数据库 | PostgreSQL | 16.x |
| 沙箱 | E2B (云端沙箱服务) | SDK 1.x |
| LLM SDK | LangChain / OpenAI Python SDK | 0.3.x |
| 认证 | FastAPI + python-jose (JWT) | — |
| 部署 | Docker Compose | — |

### 四维对比

| 维度 | 方案 A（TS 全栈） | 方案 B（Python 后端 + E2B） |
|------|-------------------|---------------------------|
| **技术栈与版本** | Node 20 + Next.js 15 + React 19 + Docker 27 + Vercel AI SDK 4 | Python 3.12 + FastAPI 0.115 + React 19 + E2B SDK 1 + LangChain 0.3 |
| **成本量级** | Docker 自建沙箱免费（需服务器 ~50 元/月）；LLM API ~2000 元/月；总 ~2050 元/月 | E2B 云端沙箱 ~$20/月（~140 元）；LLM API ~2000 元/月；总 ~2140 元/月 |
| **迁移难度** | 全栈一种语言，迁移成本低；Docker 沙箱可自托管，无供应商锁定 | 前后端两种语言；E2B 为外部 SaaS，沙箱能力受供应商影响，迁移需替换沙箱层 |
| **供应商锁定风险** | 低——Docker 是开源标准，Vercel AI SDK 支持多模型切换 | 中——E2B 沙箱是专有服务，停服或涨价直接影响核心功能；LangChain 抽象层较重 |

### 决策

**选方案 A（TypeScript 全栈 + Docker 沙箱）。**

理由：
1. **一种语言贯穿全栈**——1 人团队，减少认知负担和上下文切换
2. **Docker 自建沙箱无供应商锁定**——E2B 停服或涨价会直接卡住方案 B 的核心功能
3. **成本更低**——Docker 自建沙箱不产生额外 SaaS 费用
4. **Vercel AI SDK 原生支持多模型切换**——OpenAI/Claude/国产模型可随时切换，不被单一 API 锁定
5. **用户已熟悉 TypeScript**——学习成本最低

风险与缓解：
- Docker 沙箱安全性需自行保障 → MVP 用严格的资源限制 + 只读挂载 + 网络隔离
- Next.js API Routes 做长循环可能有超时问题 → 用 Server-Sent Events (SSE) 流式返回 + 后台 Worker 线程

---

## 三、技术设计

### 3.1 系统架构总览（含自我进化层）

```
┌──────────────────────────────────────────────────────────────────┐
│                      元级 Loop (跨会话自我进化)                    │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────┐  │
│  │ 经验记忆库    │  │ 策略评分器    │  │ Prompt 进化器          │  │
│  │ (向量DB)     │  │ (成功率追踪)  │  │ (规则自动追加)          │  │
│  └──────┬───────┘  └──────┬───────┘  └───────────┬───────────┘  │
│         │                 │                       │              │
│         └─────────┬───────┴───────────────────────┘              │
│                   │ 定期回顾 → 提取模式 → 更新策略/Prompt          │
└───────────────────┼──────────────────────────────────────────────┘
                    │ 注入经验和策略
┌───────────────────▼──────────────────────────────────────────────┐
│                    任务级 Loop (单会话)                           │
│  observe → think → act → evaluate → 反馈                          │
│                                                                  │
│  ┌─────────┐   ┌─────────┐   ┌─────────┐   ┌──────┐            │
│  │ Planner │   │ Memory  │   │ Tool    │   │Reflect│            │
│  │+经验注入 │   │+历史检索 │   │Executor │   │+策略评│            │
│  │         │   │         │   │         │   │  分   │            │
│  └─────────┘   └─────────┘   └─────────┘   └──────┘            │
│              ReAct: Thought → Action → Observation → ...         │
└──────────────────────────────────────────────────────────────────┘
                    │
┌───────────────────▼──────────────────────────────────────────────┐
│                    Harness (运行时基础设施)                        │
│  Docker沙箱 / 上下文管理 / 状态持久化 / 安全治理 / LLM路由          │
└──────────────────────────────────────────────────────────────────┘
```

**两层 Loop 的分工**：

| 层级 | 职责 | 频率 | 对应概念 |
|------|------|------|---------|
| 任务级 Loop | 单次任务内循环修正（ReAct + Reflexion） | 每次会话 | "这一次内别重复翻车" |
| 元级 Loop | 跨会话复盘进化（经验提取 + 策略更新） | 每 N 个任务或每天 | "下一次别在同一个地方翻车" |

### 3.2 核心模块设计

#### 3.2.1 Agent Runtime（Harness + Loop）

这是系统的心脏，对应之前知识地图里的概念层 → 工程层映射：

| 概念层组件 | 工程层实现 | 职责 |
|-----------|-----------|------|
| 规划 Planning | Planner 模块（LLM 调用 + CoT/ReAct prompt） | 拆任务、定下一步 |
| 记忆 Memory | Context Manager + DB 会话存储 + 经验记忆库 | 短期=上下文窗口，长期=DB+向量检索，跨会话=经验库 |
| 工具使用 Tool Use | Tool Executor（文件/终端/代码执行） | 调用工具、收集结果 |
| 自我反思 Reflection | Reflect 模块（LLM 调用）+ 元级 Loop | 任务内评估+生成约束，跨会话提取模式+更新策略 |

**任务级 Loop 核心伪代码**：

```typescript
async function agentLoop(task: string, sessionId: string): AsyncGenerator {
  // 0. 经验注入：从经验库检索相似任务的历史经验
  const experiences = await experienceDB.searchSimilar(task, topK: 3);
  const strategies = await strategyDB.getTopStrategies(task, limit: 3);
  const promptRules = await promptEvolver.getCurrentRules();

  const context = await loadContext(sessionId);
  context.injectExperiences(experiences);   // 注入历史经验
  context.injectStrategies(strategies);     // 注入高成功率策略
  context.injectPromptRules(promptRules);   // 注入进化后的规则

  let done = false;
  let steps = 0;
  const MAX_STEPS = 50;

  while (!done && steps < MAX_STEPS) {
    // 1. Thought: LLM 思考下一步（带经验上下文）
    const thought = await planner.think(task, context);
    yield { type: 'thought', data: thought };

    if (thought.action === 'finish') { done = true; break; }

    // 2. Action: 执行工具调用
    const result = await toolExecutor.execute(thought.action, thought.params);
    yield { type: 'action', data: thought.action };
    yield { type: 'observation', data: result };

    // 3. 更新上下文（可能触发压缩）
    context.addStep(thought, result);
    await contextManager.compressIfNeeded(context);

    // 4. Reflect: 每 N 步反思一次
    if (steps % 5 === 4) {
      const reflection = await reflect.evaluate(context);
      context.addReflection(reflection);
      yield { type: 'reflection', data: reflection };
    }

    steps++;
  }

  // 5. 经验存储：任务结束后把经验写入经验库
  const outcome = { task, steps, success: done, strategies: context.usedStrategies };
  await experienceDB.store(sessionId, outcome);
  await strategyDB.recordOutcome(context.usedStrategies, done);

  await saveContext(sessionId, context);
  yield { type: 'finish', steps };
}
```

**元级 Loop 伪代码**（定期触发，独立于任务级 Loop）：

```typescript
async function metaLoop(): Promise<void> {
  // 每 10 个已完成任务或每天触发一次
  const recentSessions = await sessionDB.getCompleted(limit: 10);

  // 1. 回顾：从经验库拉取最近会话
  const experiences = await experienceDB.getRecent(limit: 10);

  // 2. 提取：用 LLM 归纳可复用的模式/教训
  const patterns = await llm.extractPatterns(experiences);
  //   patterns = {
  //     successPatterns: [{ condition, strategy, evidence }],
  //     failurePatterns: [{ condition, mistake, fix }],
  //     projectRules: ["Next.js 用 app/ 不用 pages/", "测试用 vitest"]
  //   }

  // 3. 更新：写入策略库 + 更新 prompt 规则
  for (const p of patterns.successPatterns) {
    await strategyDB.upsert(p);
  }
  for (const rule of patterns.projectRules) {
    await promptEvolver.appendRule(rule);
  }

  // 4. 验证：对历史失败任务重跑，看策略是否变好
  for (const failed of recentSessions.filter(s => !s.success)) {
    const replayResult = await replay(failed, newStrategies);
    if (replayResult.success) {
      await auditLog.record('strategy_improvement', { session: failed.id });
    }
  }

  // 5. 清理：淘汰长期低成功率策略
  await strategyDB.pruneLowSuccess(threshold: 0.2);
}
```

#### 3.2.2 Docker 沙箱设计

```
┌─────────────────────────────────────────┐
│         Docker Sandbox Container         │
│                                         │
│  ┌─────────┐  ┌──────────┐  ┌────────┐│
│  │ 工作目录  │  │ /tmp     │  │ 网络   ││
│  │ (只读挂载 │  │ (可写)   │  │ 隔离   ││
│  │  用户项目)│  │          │  │ (none) ││
│  └─────────┘  └──────────┘  └────────┘│
│                                         │
│  资源限制:                               │
│  - CPU: 1 core                          │
│  - Memory: 512MB                        │
│  - 磁盘: 1GB                            │
│  - 超时: 30s/命令                        │
│  - 无 Docker-in-Docker                  │
│                                         │
│  预装: Python 3.12, Node 20, git,      │
│        常见包管理器                       │
└─────────────────────────────────────────┘
```

安全措施：
- `--network=none` 网络隔离（防止代码外联）
- `--read-only` 只读根文件系统 + tmpfs 可写区
- `--memory=512m --cpus=1` 资源限制
- `--security-opt=no-new-privileges` 禁止提权
- 每个会话独立容器，任务结束即销毁

#### 3.2.3 上下文管理

```
上下文窗口 (128K tokens)
┌──────────────────────────────────────────┐
│ 系统提示词 (固定)              ~2K tokens │
│ 工具定义 (固定)                ~2K tokens │
│ 任务描述                       ~1K tokens │
│ ─────────────────────────────────────── │
│ 历史步骤 (动态，可能被压缩)               │
│  Step 1: Thought + Action + Observation  │
│  Step 2: ...                             │
│  Step N: ...                             │
│ ─────────────────────────────────────── │
│ 反思摘要 (每5步生成)           ~1K tokens │
│ 当前观察 (最新)                ~4K tokens │
└──────────────────────────────────────────┘
```

压缩策略（当上下文接近 80% 容量时触发）：
1. 保留最近 5 步的完整记录
2. 更早的步骤用 LLM 生成摘要（每 5 步 → 1 段摘要）
3. 保留所有反思摘要（它们已经是压缩后的高层信息）
4. 丢弃中间的工具原始输出（只保留摘要）

#### 3.2.4 数据模型

```sql
-- 用户表
CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  email       TEXT UNIQUE NOT NULL,
  name        TEXT,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 会话表
CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  title       TEXT,
  status      TEXT DEFAULT 'active',  -- active | completed | failed
  project_path TEXT,                  -- 用户项目挂载路径
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 会话步骤表（每一步 Thought/Action/Observation）
CREATE TABLE session_steps (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  step_num    INTEGER NOT NULL,
  type        TEXT NOT NULL,           -- thought | action | observation | reflection
  content     TEXT NOT NULL,           -- JSON: { thought, action, params, result }
  tokens_used INTEGER,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 上下文快照表（用于会话恢复）
CREATE TABLE context_snapshots (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  step_num    INTEGER NOT NULL,
  context     TEXT NOT NULL,           -- 压缩后的上下文 JSON
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 审计日志
CREATE TABLE audit_logs (
  id          TEXT PRIMARY KEY,
  session_id  TEXT REFERENCES sessions(id),
  user_id     TEXT REFERENCES users(id),
  action      TEXT NOT NULL,           -- tool_call | file_write | command_exec | strategy_improvement
  detail      TEXT,                    -- JSON
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 经验记忆库（跨会话自我进化核心）
CREATE TABLE experiences (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  task_desc   TEXT NOT NULL,           -- 任务描述
  task_embedding BLOB,                 -- 任务描述的向量嵌入（用于相似检索）
  outcome     TEXT NOT NULL,           -- success | failure | partial
  steps_count INTEGER,
  strategies_used TEXT,                -- JSON: 使用的策略列表
  key_turning_points TEXT,             -- JSON: 关键转折点（成功/失败的决定性步骤）
  lessons     TEXT,                    -- LLM 提取的经验教训
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 策略评分库（追踪什么策略对什么任务有效）
CREATE TABLE strategies (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,           -- 策略名称
  description TEXT,                    -- 策略描述
  conditions  TEXT,                    -- JSON: 适用条件（任务类型/技术栈/场景）
  success_count INTEGER DEFAULT 0,     -- 成功次数
  failure_count INTEGER DEFAULT 0,     -- 失败次数
  total_count  INTEGER DEFAULT 0,      -- 总使用次数
  success_rate REAL DEFAULT 0.0,       -- 成功率 = success_count / total_count
  last_used   TIMESTAMP,               -- 上次使用时间
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Prompt 进化规则库（系统提示词自动追加的规则）
CREATE TABLE prompt_rules (
  id          TEXT PRIMARY KEY,
  rule        TEXT NOT NULL,           -- 规则内容（如"Next.js 项目用 app/ 不用 pages/"）
  source      TEXT NOT NULL,           -- experience_extracted | manual
  evidence    TEXT,                    -- JSON: 支撑证据（来源会话ID列表）
  confidence  REAL DEFAULT 0.5,        -- 置信度（0-1，随证据增加而上升）
  status      TEXT DEFAULT 'active',   -- active | deprecated
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

#### 3.2.5 API 契约

| 端点 | 方法 | 用途 | 响应 |
|------|------|------|------|
| `/api/auth/signin` | POST | 登录 | JWT token |
| `/api/sessions` | GET | 列出当前用户会话 | Session[] |
| `/api/sessions` | POST | 创建新会话 | Session |
| `/api/sessions/:id` | GET | 获取会话详情 + 步骤 | Session + Steps |
| `/api/sessions/:id/run` | POST | 提交任务，启动 Agent Loop | SSE 流 |
| `/api/sessions/:id/stop` | POST | 中止当前 Loop | 200 OK |
| `/api/sessions/:id/files` | GET | 获取工作区文件列表 | FileNode[] |
| `/api/sessions/:id/files/:path` | GET | 读取文件内容 | File content |
| `/api/health` | GET | 健康检查 | { status, version } |

**SSE 流事件格式**：

```json
{ "type": "thought", "data": "我需要先读取现有项目结构..." }
{ "type": "action", "data": { "tool": "list_files", "params": { "path": "." } } }
{ "type": "observation", "data": "[\"src/\", \"package.json\", \"README.md\"]" }
{ "type": "reflection", "data": "项目是 Node.js 项目，下一步应读取 package.json" }
{ "type": "finish", "data": { "steps": 12, "result": "已创建 src/routes/users.ts + tests/users.test.ts" } }
```

### 3.3 安全设计

| 威胁 | 缓解措施 |
|------|---------|
| 用户代码执行恶意命令 | Docker 沙箱隔离 + 网络隔离 + 资源限制 |
| 路径穿越攻击 | 工具层做路径白名单校验，禁止访问工作区外 |
| LLM 生成恶意工具调用 | 工具调用前做参数校验 + 危险命令黑名单 |
| 会话数据泄露 | 用户隔离（每会话独立容器 + 独立工作区） |
| API 密钥泄露 | 密钥存环境变量，不进代码/日志/对话 |
| DoS（无限循环） | MAX_STEPS=50 硬上限 + 单步超时 30s + 总会话超时 10min |

### 3.4 目录结构

```
ai-coding-agent/
├── src/
│   ├── app/                    # Next.js App Router
│   │   ├── (auth)/             # 登录/注册页
│   │   ├── dashboard/           # 会话列表
│   │   ├── session/[id]/       # 单会话界面
│   │   ├── api/                # API Routes
│   │   │   ├── auth/
│   │   │   ├── sessions/
│   │   │   └── health/
│   │   ├── layout.tsx
│   │   └── page.tsx
│   ├── lib/
│   │   ├── agent/              # Agent 核心
│   │   │   ├── loop.ts         # Loop 引擎
│   │   │   ├── planner.ts      # 规划模块
│   │   │   ├── reflector.ts    # 反思模块
│   │   │   └── types.ts        # 类型定义
│   │   ├── tools/              # 工具实现
│   │   │   ├── fileOps.ts      # 文件读写
│   │   │   ├── codeExec.ts     # 代码执行（Docker）
│   │   │   ├── terminal.ts     # 终端命令（Docker）
│   │   │   └── registry.ts     # 工具注册表
│   │   ├── sandbox/            # Docker 沙箱管理
│   │   │   ├── container.ts    # 容器生命周期
│   │   │   └── config.ts       # 安全配置
│   │   ├── context/            # 上下文管理
│   │   │   ├── manager.ts      # 压缩/截断
│   │   │   └── compressor.ts   # LLM 摘要压缩
│   │   ├── evolution/          # 自我进化模块（元级 Loop）
│   │   │   ├── metaLoop.ts     # 元级 Loop 调度器
│   │   │   ├── experienceDB.ts # 经验记忆库（向量存储+检索）
│   │   │   ├── strategyDB.ts   # 策略评分器
│   │   │   ├── promptEvolver.ts # Prompt 进化器
│   │   │   └── patternExtractor.ts # 模式提取（LLM 归纳）
│   │   ├── llm/                # LLM 路由
│   │   │   ├── router.ts       # 多模型切换
│   │   │   └── prompts.ts      # 系统提示词
│   │   ├── db/                 # 数据库层
│   │   │   ├── schema.ts       # Drizzle ORM schema
│   │   │   └── client.ts       # 连接管理
│   │   └── auth/               # 认证
│   │       └── config.ts       # NextAuth 配置
│   ├── components/             # React 组件
│   │   ├── chat/               # 对话界面
│   │   ├── code/               # 代码预览 (Monaco)
│   │   └── common/             # 通用组件
│   └── styles/                 # 全局样式
├── docker/
│   ├── sandbox.Dockerfile      # 沙箱镜像
│   └── app.Dockerfile          # 应用镜像
├── docker-compose.yml          # 一键启动
├── .env.example                # 环境变量模板
├── package.json
├── tsconfig.json
└── README.md
```

---

## 四、分阶段实施计划

### Phase 1：MVP 骨架（2 周）

**目标**：跑通最小 ReAct 闭环——用户输入任务，Agent 能读文件、写文件、跑命令、返回结果。

| 任务 | 退出条件 |
|------|---------|
| 搭建 Next.js 项目骨架 | `npm run dev` 能启动，首页可访问 |
| 实现 Docker 沙箱管理器 | 能创建/销毁容器，容器内能执行 `echo hello` |
| 实现工具层（文件读写 + 终端） | 在沙箱内能 `ls`、`cat`、`write` 文件 |
| 实现 LLM Router（接 OpenAI API） | 能发送 prompt 并收到回复 |
| 实现 ReAct Loop 最小版 | 能跑 Thought→Action→Observation 循环 |
| 基本对话界面（SSE 流式） | 浏览器能看到 Agent 的实时输出 |

**Phase 1 验收**：在浏览器输入"创建一个 hello.js 文件，内容是 console.log('hello')"，Agent 能自主完成，文件出现在工作区。

### Phase 2：Agent 核心能力（2 周）

**目标**：能完成中等复杂度编程任务，有上下文管理和反思能力。

| 任务 | 退出条件 |
|------|---------|
| 上下文管理器（压缩/截断） | 50 步循环不超出上下文窗口 |
| 反思模块 | 每 5 步生成反思摘要，影响后续决策 |
| 代码执行工具 | 能在沙箱内运行 JS/Python 代码并返回 stdout |
| 会话持久化 | 刷新页面后会话状态不丢失 |
| 代码 Diff 预览（Monaco） | Agent 修改文件后能展示 diff |
| 任务中止功能 | 用户能随时停止运行中的 Loop |

**Phase 2 验收**：输入"给这个 Express 项目加一个 /api/users 的 CRUD 接口，带测试"，Agent 能自主完成，代码可运行且 `npm test` 通过。

### Phase 3：多用户 + 安全加固 + 经验记忆库（2 周）

**目标**：5-20 人可用，安全可靠，任务结束后能存经验。

| 任务 | 退出条件 |
|------|---------|
| NextAuth 认证（邮箱/密码） | 未登录无法访问任何 API |
| 用户隔离（每会话独立容器） | 用户 A 看不到用户 B 的文件 |
| 审计日志 | 所有工具调用有日志可查 |
| 危险命令黑名单 | `rm -rf /`、`curl | bash` 等被拦截 |
| 资源配额 | 单用户最多 3 个并发会话 |
| Docker Compose 一键部署 | `docker-compose up` 全系统启动 |
| **经验记忆库**（任务结束后存经验） | 能检索到历史相似任务 |
| **策略评分器**（追踪成功率） | 策略库有 ≥3 条带成功率数据的策略 |

**Phase 3 验收**：两个用户同时使用，互不干扰；尝试执行危险命令被拦截并记录日志；完成 5 个任务后，经验库能检索到相似历史任务。

### Phase 4：Loop 优化 + Prompt 进化（2 周）

**目标**：从"能用"到"好用"，系统提示词能根据经验自动进化。

| 任务 | 退出条件 |
|------|---------|
| 多模型切换（OpenAI/Claude/国产） | 配置切换模型，效果不退化 |
| 上下文压缩优化 | 100 步任务不崩 |
| 任务面板（进度/状态可视化） | 用户能看到当前在第几步、在做什么 |
| 错误恢复（网络超时/工具失败重试） | 单步失败不导致整个 Loop 崩溃 |
| **Prompt 进化器**（规则自动追加） | 跑 20 个任务后，系统提示词自动包含 ≥5 条经验规则 |
| **经验注入**（新任务开始时检索历史） | 第 N+1 个同类任务比第 1 个步数更少或成功率更高 |
| README + 部署文档 | 新用户按文档能独立部署 |

**Phase 4 验收**：完整跑通"给现有项目添加带测试的 CRUD 接口"任务，全程无人工干预；跑 20 个任务后，系统提示词包含至少 5 条从经验中提取的规则；同类任务第 20 次比第 1 次平均步数减少。

### Phase 5：元级 Loop + 自我进化闭环（2 周，可选）

**目标**：从"越用越好"到"自动复盘进化"。

| 任务 | 退出条件 |
|------|---------|
| 元级 Loop 调度器（定期触发） | 每 10 个任务或每天自动触发一次 |
| 模式提取器（LLM 归纳历史模式） | 能从 10 个会话中提取 ≥3 条可复用模式 |
| 策略库自动更新（upsert + 淘汰） | 低成功率策略（<20%）被自动淘汰 |
| 历史失败任务重放验证 | 至少 1 个历史失败任务用新策略重跑成功 |
| 经验库可视化界面 | 用户能看到 Agent 学到了什么规则 |
| 策略库导出/导入 | 经验可跨部署迁移 |

**Phase 5 验收**：系统运行 30 个任务后，元级 Loop 自动触发过至少 3 次；策略库包含 ≥10 条策略，成功率数据准确；至少 1 个历史失败任务用进化后的策略重跑成功；用户能在界面上查看 Agent 自动学到的规则。

---

## 五、风险与假设

### 风险

| 风险 | 概率 | 影响 | 缓解 |
|------|:---:|:---:|------|
| LLM API 费用超预算 | 中 | 高 | 加 token 用量监控 + 单会话上限 |
| Docker 沙箱安全漏洞 | 低 | 高 | 严格隔离 + 定期更新基础镜像 |
| 长任务上下文溢出 | 中 | 中 | 压缩策略 + MAX_STEPS 硬上限 |
| LLM 输出格式不稳定 | 高 | 中 | 容错解析 + 重试机制 |
| 单人开发进度延误 | 中 | 中 | 严格按 Phase 交付，每 Phase 可独立使用 |
| 经验库噪声累积（错误经验污染策略） | 中 | 中 | 元级 Loop 验证机制 + 低成功率策略自动淘汰 + 人工审核接口 |
| Prompt 进化导致提示词膨胀 | 中 | 低 | 规则数量上限 + 置信度衰减 + 定期清理低置信度规则 |
| 向量检索质量不足（相似任务召回不准） | 中 | 中 | 多维度检索（任务描述+技术栈+任务类型）+ 人工反馈标注 |

### 假设

1. 假设用户有可访问的 LLM API Key（OpenAI / Claude / 国产模型）
2. 假设部署环境有 Docker 支持（Linux 服务器或 WSL2）
3. 假设月预算 3000 元可覆盖 ~20 人轻度使用的 API 费用（需上线后实测校准）
4. 假设 NextAuth 邮箱密码认证对小团队内部使用足够安全
5. 假设 Docker `--network=none` 对编程任务足够（如需 npm install，需放行特定域名）

---

## 六、技术栈汇总

| 层 | 技术 | 版本 | 用途 |
|----|------|------|------|
| 运行时 | Node.js | 20 LTS | 服务端运行时 |
| Web 框架 | Next.js | 15.x | 全栈框架（API + UI） |
| 前端 | React | 19.x | UI 组件 |
| 样式 | TailwindCSS | 4.x | 原子化 CSS |
| 代码编辑器 | Monaco Editor | 0.52.x | 代码预览/Diff |
| LLM SDK | Vercel AI SDK | 4.x | 多模型统一接口 |
| 数据库 | SQLite → PostgreSQL | 16.x | 会话/用户/日志/经验/策略存储 |
| ORM | Drizzle ORM | 0.36.x | 类型安全数据库操作 |
| 认证 | NextAuth.js | 5.x | 邮箱密码认证 |
| 沙箱 | Docker | 27.x | 代码执行隔离 |
| 向量数据库 | sqlite-vec (开发) / pgvector (生产) | 0.1.x / 0.7.x | 经验记忆库相似检索 |
| 嵌入模型 | OpenAI text-embedding-3-small | — | 任务描述向量化 |
| 部署 | Docker Compose | — | 一键编排 |
| 语言 | TypeScript | 5.6.x | 全栈类型安全 |

---

## 七、下一步

1. **用户确认方案**——特别是方案 A（TS 全栈 + Docker）、五阶段计划（含自我进化）、Phase 5 是否纳入首期
2. **准备 API Key**——至少一个 LLM API（建议先用 DeepSeek/Claude，性价比高）+ 一个嵌入模型 API（text-embedding-3-small）
3. **准备服务器**——一台 Linux 服务器（2C4G 起步，~50 元/月）
4. **进入 Phase 1 开发**——按计划 2 周交付 MVP 骨架

> **关于 Phase 5（自我进化闭环）**：Phase 1-4 已经能交付一个"单任务内自我修正"的可用 Agent。Phase 5 的元级 Loop 是"跨会话自我进化"的增量——建议 MVP 上线后根据实际使用数据再决定是否投入。如果首期就要完整自我进化能力，五阶段共 10 周；如果先上线再迭代，前四阶段 8 周即可交付。

> 本文档为方案设计稿 v2（等级：概念稿→原型设计），尚未实现任何代码。批准后进入 Phase 1 开发，每阶段交付可独立运行的版本。

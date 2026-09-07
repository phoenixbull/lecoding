# M3 具体实施方案与开发进度核对

核对日期：2026-09-07。代码基线：本地 `master` / `023d0dc`；远端只读查询为 `c33be0b`。本文是实施建议，不代表已执行发布或完成目标平台验收。

## 1. 当前进度

- 本地工作区在检查开始时干净，比远端 master 多两个提交：`9f4ad01`（登出、设备撤销时撤销授权）和 `023d0dc`（CI 配置调整）。未执行推送。
- M0 历史修复已落地，但最新远端 CI 的类型检查失败，测试步骤跳过，因此发布门禁尚不能判绿。[CI 记录](https://github.com/phoenixbull/lecoding/actions/runs/33834606081)。失败日志下载遇到 EOF，具体编译错误待定位，不能把本地通过当作远端问题已经解决。
- M1 桌面绑定、共享 controller、Renderer、IPC、原生凭据与安装包构建代码已落地；真实安装、OS 凭据存储、签名、公证及升级证据未关闭。
- M2 WSS、本地执行、持久化授权、恢复去重、首次 keep/discard 决定、进程树终止与撤销链路已落地；目标平台清单仍未填入执行证据。
- M2 仍有明确功能缺口：PolicyEngine 的 `fileAccessScope` 未参与决策、本地最低验证集合未闭环、组织策略禁用 `host_full` 未实现。Windows 仅提供 `argv_fence`，无内核级文件系统隔离；独立签名 Runner 进程亦未实现。
- 自动更新的 `installVerifiedUpdate` 具备清单签名和摘要校验，但仓库调用点仅见测试，未发现生产 Main 接线；构建脚本和发布工作流也未发现与该校验器配套的签名更新清单生产链路。这是 M3 实现工作，不只是补一次升级截图。
- 既有真实黄金任务证据来自 2026-08-27 的 OpenAI 兼容模型与 Docker Desktop，不能替代当前提交的 Anthropic 和目标 Linux 证据。

当前应定性为「M2 主链路开发完成，进入发布前补齐与验收」，不继续使用总计划中旧的完成百分比。

本次本地复验：

| 命令 | 结果 |
|---|---|
| `pnpm test`（允许 loopback 的环境） | 129 文件通过 / 5 跳过；1172 测试通过 / 16 跳过 / 0 失败，退出码 0，70.07 秒 |
| `pnpm typecheck` | 25/25 通过，其中 24 项缓存 |
| `pnpm exec turbo run typecheck --force` | 25/25 通过，0 缓存，21.127 秒 |

16 个跳过为安装包 smoke 4、live 模型 2、真实 PostgreSQL 并发 1、Docker 契约 7、Docker 环境 2。首次受限沙箱执行出现 5 条 Worker HTTP `listen EPERM`，不作为产品失败结论；上述全量通过来自允许监听环境的完整重跑。日志保存在本机 `/tmp/lecodex-progress-test-host.log` 与 `/tmp/lecodex-progress-typecheck-fresh.log`，属于临时检查材料，正式 RC 应重新运行并归档不可变证据。

## 2. 范围和顺序

执行依赖：`M3.0 可信门禁 → M3.A 功能/更新链路补齐 → M3.B 固定 RC 与外部证据 → M3.C 运维演练 → M3.D 文档与发布判定`。

证书、目标机器和隔离测试数据库应从第一天准备。建议本次延续已声明的 Windows best-effort 范围与内嵌 Runner 架构，不把 AppContainer、独立 Runner 或 Phase 5 混入 M3；如果发布要求 Windows 内核级隔离，则必须新增原生开发里程碑并重估工期。

### M3.0 恢复同提交可信门禁（0.5–1 天）

1. 获取远端失败 job 的具体 TypeScript 诊断，在干净 Linux checkout 和冻结 lockfile 安装下复现；检查 Node、pnpm、依赖声明及平台差异，不凭猜测改代码。
2. 对修复先编写公开接口失败测试，再最小修复；补必要注释。检查本地两个未推送提交是否覆盖远端问题，不能仅凭 CI 配置提交名称推断已修复。
3. 固定 CI 工具版本与 packageManager 口径。普通 PR 保留确定性门禁，另设明确开启 Docker、真实 PostgreSQL 的集成 job；不能靠默认跳过得到发布绿灯。
4. 候选提交在干净安装下通过全量测试与类型检查，归档 commit、环境、命令、退出码、通过/跳过数量。

退出条件：同一候选 SHA 的 Linux CI 全绿；所有跳过均列明后续目标环境 job，稳定失败为零。

### M3.A 补齐发布实际依赖的行为（预计 3–5 天）

**A1：本地验证与权限语义。**

- 沿用 `packages/verifier` 的 reviewed verification plan 和独立验证环境 seam，确认本地 Run 消费项目声明的最低验证集合；缺计划、必需检查失败、取消、验证环境不可用时均不得生成 verified 成功。
- 从 PolicyEngine 公开 evaluate seam 固定权限范围的语义。推荐实现范围升级请求与审批，审批不能覆盖固定 deny；未批准不得签发更高档 grant。若本期决定不支持范围升级，则显式拒绝此能力并收窄接口/文档，不能保留无效字段造成安全承诺。
- 建议补项目/组织策略禁用 `host_full`：在权威服务端准入与 Main 签发端均执行拒绝，OS 确认不能覆盖管理员禁令；覆盖重启后的持久化 grant 和策略收紧场景。
- 每个切片分别运行 policy、verifier、worker 授权和 desktop runner 链路聚焦测试，然后运行 `pnpm test`、`pnpm typecheck`。

**A2：更新生产链路。**

- 发布端按平台/架构生成版本、HTTPS 下载地址与 SHA-256 清单，签署精确清单字节，产物与清单同时归档。OS 代码签名和清单 Ed25519 签名分别验证。
- Main 接入发现更新、获取清单/签名/产物、调用 `installVerifiedUpdate` 和平台安装器；可信公钥从受信发布配置提供，不能接受下载包自带的公钥。
- 在生产应用装配 seam 验证：正确签名允许进入安装器；错误签名、篡改内容、平台/架构不匹配、非更新版本、下载失败均不得触发安装。
- 使用两个可签名的相邻测试版本验证真实升级，验证用户凭据和历史状态保留。当前校验器拒绝降级，因此回滚应使用受控重装与数据恢复流程，不能绕过更新校验器。

退出条件：新装与旧版升级都能从真实入口走通；权限与验证不存在依赖 mock 或未使用字段的虚假完成声明。

### M3.B 固定 RC，收齐目标环境证据（1.5–2 天，基础设施就绪后）

固定一个 RC SHA，所有产物、报告、安装与演练记录引用该 SHA。修复引入新 SHA 后，重跑受影响证据及完整门禁。

| 验证项 | 执行入口 | 验收标准 |
|---|---|---|
| Linux 隔离 | `node scripts/run-target-linux-isolation.mjs` | 真实 Linux host 与 daemon；输出资源/隔离矩阵报告，失败不可降级 |
| Docker 公共契约 | `LECODING_DOCKER_CONTRACT=1 pnpm vitest run packages/run-environment/test/docker-contract-suite.test.ts` | 在健康 Docker 中实际执行，零环境跳过 |
| PostgreSQL | `pnpm smoke:postgres`、`pnpm smoke:postgres-failover`、`pnpm smoke:postgres-cancel`、`pnpm smoke:postgres-steering` | 使用隔离验收数据库；验证多 Worker 恢复、取消重连和 steer，无重复副作用 |
| PostgreSQL 并发 | 配置验收库 `LECODING_DATABASE_URL` 后执行 `pnpm vitest run packages/device-binding/test/postgres-concurrency.test.ts` | 使用真实数据库运行，而非仅 PGlite/mock |
| Anthropic 黄金任务 | 见下方命令 | 固定 12 个 acceptance 任务，归档每项结果、总通过率、token、成本计算口径和耗时 |
| 桌面平台 | 既有 M1/M2 smoke checklist | Windows x64、macOS arm64/x64 对应产物可安装；原生存储、Run 闭环、重启撤销、授权与进程树行为有证据 |
| 签名与公证 | 既有 desktop-release 工作流和目标系统验证 | 同 tag 的 Windows 三件套及 macOS DMG/ZIP；内部架构/版本一致，签名有效，macOS 公证有效 |

Anthropic 执行示例（先由测试环境注入模型配置、有效凭据和当前计价参数，禁止把秘密写进证据）：

```bash
RUN_LIVE_GOLDEN=1 \
LECODING_GOLDEN_SUITE=acceptance \
LECODING_GOLDEN_REPORT=.artifacts/m3/anthropic-acceptance.json \
pnpm vitest run packages/anthropic-model/test/live-agent-model-baseline.test.ts
```

当前 live 测试只断言任务数量与 token 非零，不断言通过率。新增报告门禁必须通过公开评估结果 seam 测试。建议首个 RC 要求 12/12；这是本方案建议的新标准，应写入发布规则。保留全部尝试，禁止只挑成功轮次；成本/时长预算在执行前记录，不采用旧文档价格冒充当前账单。

修正 smoke 清单的证据语义：进程创建前被 argv/path fence 拦截不等于内核拒绝；macOS 要分别验证预检拒绝和进程内部越界访问被 Seatbelt 拒绝。不得通过重命名系统 `sandbox-exec` 破坏测试机器；使用可控探针故障或不可用 adapter 场景。Windows `argv_fence` 与真实进程树终止分别取证，不能写成 Job Object。

### M3.C 运维演练（1–2 天）

仅在独立 staging 和新建数据库中演练，使用 `docs/operations-runbook.md`，不对现有数据库执行破坏性恢复。

1. 创建包含完成、待审批、运行中和待处置 Run 的数据集；备份 PostgreSQL 与 Artifact 并记录一致性时间点。
2. 恢复到空环境，逐项核对 Run、事件 cursor、审批、设备和 Artifact SHA-256；检查未完成工具调用不得自动重放。
3. 选真实可比的前后 schema 版本，在演练分支做升级、启动检查、回滚恢复；如本次没有 schema 差异，用独立迁移夹具验证，不为演练往生产 schema 加无用字段。
4. 纠正 runbook 中对「仅恢复数据」和手动删列的含混说明，给出经过验证的 schema/数据/二进制兼容矩阵。优先恢复到新建旧版库再切换，不能默认新 schema 可被旧代码安全读取。
5. 验证 retention 保留边界、Artifact 引用一致性、worktree 清理失败 residual 与告警。记录恢复耗时、数据损失窗口、人工步骤和实际结果。
6. 演练桌面正常升级与失败恢复，确认签名校验不可绕过。

退出条件：其他操作者按文档可重复备份、恢复、升级和回滚；记录实际 RTO/RPO，不编造已达成的 SLO。

### M3.D 审计与文档收口（0.5–1 天）

- 更新 README 的 workspace 清单、桌面启动/安装、本地 Runner 和平台限制。
- 更新 `latest-development-plan.md`、M1/M2 summary、Phase 4 status/completion audit、部署文档与 runbook。替换过期数字，区分历史证据与当前候选证据。
- 按 `docs/evidence/m3/<candidate>/` 建立证据索引：SHA/tag、执行人、日期、OS/架构、产物摘要、环境版本、命令/退出码、结果、跳过原因和原始日志链接；日志脱敏，数据库备份不入库。
- 生成 release notes、已知限制、兼容矩阵、升级/回滚步骤和最终逐项 release checklist。
- M1/M2 原有未满足的验收项逐项引用新证据后才关闭。缺证书或目标平台时保留 RC/预发布状态，不把未执行写成通过。

## 3. 工期与交付划分

原 M3 的 3–5 天只适用于功能闭环和签名环境都已就绪的情况。按本次发现，建议预留 **7–11 个工作日**，证书申请、目标机器和发布账号等待时间另计；这是基于当前检查的估算，更新/权限切片发现额外缺陷后应调整。

建议独立交付顺序：CI 修复与基线 → 本地最低验证集合 → 权限语义/管理员限制 → 更新清单生产与 Main 接线 → 外部证据 job → 平台 smoke → 恢复回滚演练 → 最终文档。每个代码切片均按 AGENTS.md 红—绿 TDD、补意图注释、聚焦测试、全量测试与类型检查执行。

最终发布判定：同 SHA 质量门禁通过；签名、公证、更新与平台安装成立；M1/M2 必需证据齐全；备份恢复、schema 升级回滚、清理告警可复现；已知能力边界准确公开。未满足时只交付 RC 和未完成清单。

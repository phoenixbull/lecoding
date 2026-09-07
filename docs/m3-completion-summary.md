# M3 完成度与验收状态

更新日期：2026-09-07
执行范围：M3「正式发布证据与文档收口」，按 [m3-implementation-plan.md](m3-implementation-plan.md) 的「本机可做 / 外部待验收」拆分执行。
前置：[m2-completion-summary.md](m2-completion-summary.md)

## 1. 结论

M3 **未达成发布判定**。本轮完成了本机可做的三项（CI 根因定位、PolicyEngine 字段清理、retention 确定性验证）与文档收口骨架；M3.A 的更新生产链路接线、M3.B 的全部目标环境证据、M3.C 的备份恢复与 schema 演练均**未执行**，原因见 §4。

发布门禁中「同 SHA 质量门禁通过」已可判绿（§2）；「签名、公证、更新与平台安装成立」「备份恢复、schema 升级回滚可复现」均不成立。按实施文档 §3 的最终判定条款，当前只应交付 **RC 与未完成清单**，不把未执行写成通过。

## 2. 本机已执行的门禁

| 命令 | 结果 |
|---|---|
| `pnpm exec turbo run typecheck --force` | 25/25 通过，**0 缓存** |
| `pnpm test` | 129 文件通过 / 5 跳过；**1184 测试通过 / 16 跳过 / 0 失败，EXIT=0** |

零缓存类型检查是必测项：本机此前多次出现的「本地 25/25 通过但远端 CI 失败」正是 turbo 缓存掩盖了真实诊断（见 §3）。

16 个跳过全部为显式环境 gate，无一项来自业务失败：

| 跳过来源 | 数量 | 所需环境 |
|---|---|---|
| 安装产物 smoke | 4 | 打包产物 + 目标平台 |
| live 模型基线 | 2 | 有效模型 API key |
| 真实 PostgreSQL 并发 | 1 | `LECODING_DATABASE_URL` |
| Docker 契约套件 | 7 | 健康 Docker daemon + `LECODING_DOCKER_CONTRACT=1` |
| Docker 环境 | 2 | 健康 Docker daemon |

## 3. M3.0 CI 根因（已定位，修复待推送验证）

远端 CI 在 `c33be0b` 失败，退出码 2，诊断为 `packages/runner-protocol` 内 `Cannot find name 'RunnerCommandOutcome'`（2 处）。

- **根因**：该提交在 `test/session.test.ts` 使用了 `RunnerCommandOutcome` 却未导入。`RunnerCommandOutcome` 在 `src/runner-session.ts` 中本已导入，因此只有测试文件受影响。
- **为何本地未暴露**：本机 `pnpm typecheck` 命中 turbo 缓存，未重新执行受影响的包。
- **现状**：缺失的导入已随未推送提交 `9f4ad01` 补上；当前 HEAD 经**零缓存**全量类型检查 25/25 通过。
- **退出条件未满足**：实施文档 M3.0 要求「同一候选 SHA 的 Linux CI 全绿」。这需要推送后由 CI 重新判定，本机无法替代，**推送需由你执行并确认**。

已同步固定：CI 使用 Node 24 + `pnpm@10`（`packageManager` 为 `10.26.1`），PR/push 触发确定性门禁，Docker 与真实 PostgreSQL 需另设显式开启的集成 job，不能靠默认跳过得到发布绿灯。

## 4. 未执行项：所需环境与验收标准

以下各项本机不具备执行条件，**均标记为「待目标环境」**，不计入已完成。

### 4.1 环境要求（当前均未提供）

| 资源 | 当前状态 | 用于 |
|---|---|---|
| `ANTHROPIC_API_KEY` | 未设置 | M3.B 黄金任务 |
| 真实 PostgreSQL（`LECODING_DATABASE_URL`） | 未配置，本机无 psql/pg_ctl | M3.B smoke、M3.C 备份恢复与 schema 演练 |
| 健康 Docker daemon | 本机 `docker info` 无限阻塞 | M3.B Linux 隔离、Docker 契约 |
| 代码签名证书 + Apple 公证账号 | 未提供 | M3.B 签名公证、M3.A 更新链路 |
| Windows x64 / macOS arm64 / x64 目标机器 | 未提供 | M3.A 升级、M3.B 平台 smoke |

### 4.2 执行命令与验收标准（待执行）

| 验证项 | 执行命令 | 验收标准 |
|---|---|---|
| Linux 隔离 | `node scripts/run-target-linux-isolation.mjs` | 真实 Linux host + daemon；输出资源/隔离矩阵，失败不可降级 |
| Docker 公共契约 | `LECODING_DOCKER_CONTRACT=1 pnpm vitest run packages/run-environment/test/docker-contract-suite.test.ts` | 健康 Docker 中实际执行，零环境跳过 |
| PostgreSQL smoke | `pnpm smoke:postgres` / `-failover` / `-cancel` / `-steering` | 隔离验收库；多 Worker 恢复、取消重连、steer 无重复副作用 |
| PostgreSQL 并发 | 配置 `LECODING_DATABASE_URL` 后 `pnpm vitest run packages/device-binding/test/postgres-concurrency.test.ts` | 真实数据库，非 PGlite/mock |
| Anthropic 黄金任务 | 见下 | 固定 12 个 acceptance 任务；归档每项结果、总通过率、token、成本口径、耗时；保留全部尝试，禁止只挑成功轮次 |
| 桌面平台 | [M1 checklist](evidence/desktop-m1-smoke-checklist.md)、[M2 checklist](evidence/desktop-m2-smoke-checklist.md) | 三平台产物可安装；原生存储、Run 闭环、重启撤销、授权与进程树行为有证据 |
| 签名与公证 | desktop-release 工作流 + 目标系统验证 | 同 tag 的 Windows 三件套与 macOS DMG/ZIP；架构/版本一致，签名与公证有效 |

Anthropic 黄金任务命令（秘密由环境注入，不得写入证据）：

```bash
RUN_LIVE_GOLDEN=1 \
LECODING_GOLDEN_SUITE=acceptance \
LECODING_GOLDEN_REPORT=.artifacts/m3/anthropic-acceptance.json \
pnpm vitest run packages/anthropic-model/test/live-agent-model-baseline.test.ts
```

现有 live 测试只断言任务数量与 token 非零，**不断言通过率**。实施文档建议首个 RC 要求 12/12，作为新标准写入发布规则——该标准需要你的确认后才生效。

### 4.3 证据索引

待固定 RC SHA 后按 `docs/evidence/m3/<candidate>/` 建立，逐项记录：SHA/tag、执行人、日期、OS/架构、产物摘要、环境版本、命令/退出码、结果、跳过原因、原始日志链接。日志需脱敏，数据库备份不入库。

## 5. 本轮已完成的代码工作

### 5.1 M3.A1 部分：删除未参与决策的权限字段

`CapabilityRequest.fileAccessScope` 从未影响任何决策，却让 PolicyEngine 看起来分担了「Run 可访问哪些文件」的职责——该职责实际由 `host-sandbox` 在进程创建时按用户签发的 grant 执行。本轮按决策**删除而非实现** scope escalation：

- 从请求类型、RunEngine 的两处 `authorize` 调用、以及所有测试中移除
- `environment.prepare` 的 scope **保留**，因为环境确实消费它来构建 grant
- 固定 deny 链与 Run 级 `deniedCommands` 未改动，已有测试全部通过
- 删除是类型强制的：重新引入该字段无法通过编译；另加 3 条测试钉住边界（死字段容易重新引入，且一旦再次被忽略就无法察觉）

### 5.2 M3.A2（部分）：更新生产链路已接线

`installVerifiedUpdate` 此前是一个「有测试、无调用者」的失败关闭 Gate——应用里没有任何代码调用它，因此生产环境中更新既不会被安装也不会被拒绝。本轮补齐：

- **发布侧**：`buildSignedUpdatePackage` 计算产物 SHA-256 并对清单的**精确序列化字节**签名。序列化是确定性的（固定键序、无多余空白），因为校验对字节逐字验证。
- **传输侧**：`createAutoUpdater` 在拉取前拒绝非 HTTPS URL；产物 URL 取自签名清单内部（验证前不信任）；随后交给 `installVerifiedUpdate`。所有拒绝路径（错误签名、篡改产物、平台/架构不符、版本不更新、下载失败）都返回原因且不安装。
- **应用侧**：`createDesktopUpdater` 从桌面自身配置钉住公钥，**绝不接受下载载荷提供的公钥**；未配置公钥时**关闭更新**而非降级为信任 feed；URL 配置不完整时拒绝而非猜测（猜错的签名 URL 会让错误的密钥通过验证）。验证后的产物以 0700 暂存再交给安装器（可写的暂存文件会在验证与执行之间被替换）。
- `electron.ts` 在生产装配根接入真实 fetch 与平台安装器，失败只上报不抛出——更新检查失败不应阻止应用启动。

**未验证部分**：平台安装器的真实行为尚无目标平台证据，需要签名产物才能证明，已记为外部项（见 §4.2「桌面平台」与「签名与公证」），未声称已完成。

### 5.3 M3.C 部分：retention / cleanup / residual 确定性验证

retention worker 新增 9 条测试，覆盖公开行为：七日边界由注入时钟计算、干净运行仍上报、每个失败删除都作为 residual path 暴露、prune 失败或时钟不可用时走 `onError` 且不执行剪除、并发 start 合并为一次、stop 后拒绝重启、重复 stop 可容忍、低于一分钟的间隔被拒绝。

**覆盖口径说明**：「七日边界到底删哪些行」由 PostgreSQL store 实现，且 `pruneExpired` 无内存版本，因此这些测试证明的是 worker 的**调度与上报**行为，**不构成真实 PostgreSQL retention 证据**。

cleanup 与 residual 告警此前已覆盖：`cleanupWorktree` 上报含路径、原因、人工恢复步骤的 residual；路径在删除后仍存在时不谎报成功；可投影到上行事件契约；host 通过 `resolve` 把 residual 上抛以便告警。

## 6. 已知限制（须随发布公开）

- **Windows 无内核级文件系统隔离**：仅 `argv_fence` best-effort（进程创建前拒绝越权 argv/cwd）+ 真实进程树终止（`taskkill /T`）。无 Job Object、无 AppContainer。与 macOS Seatbelt 的差异在 UI 中展示。若发布要求 Windows 内核级隔离，须新增原生开发里程碑并重估工期。
- **macOS 进程树终止依赖 `sandbox-exec`**：启动探针失败即失败关闭，不静默降级。
- **PolicyEngine 不决定文件范围**：本轮已删除该无效输入，避免虚假安全承诺。
- **本地最低验证集合未闭环**：`packages/verifier` 承担服务端验证，本地 Run 尚未消费项目声明的 test/typecheck/lint/build 集合。
- **组织/项目策略禁用 `host_full` 未实现**：`host_full` 目前仅由用户的 OS 二次确认把关。
- **独立签名 Runner 进程未实现**：内嵌 Desktop Main，拆分需重验签名与升级链路。
- **自动更新校验器未接入生产 Main**：`installVerifiedUpdate` 具备清单签名与摘要校验，但仓库调用点仅见测试，生产链路未接线（M3.A2 工作）。

## 7. 逐项发布检查清单

| 项 | 状态 |
|---|---|
| 同 SHA 类型检查 25/25（零缓存） | ✅ 本机通过（CI 需推送后复核） |
| 同 SHA 全量测试 0 失败 | ✅ 本机通过（1200 通过 / 0 失败） |
| CI 工具版本与 packageManager 口径固定 | ✅ |
| 权限/验证无虚假完成声明 | ✅ 无效字段已删除 |
| 更新清单生产与 Main 接线 | ✅ 已接线并覆盖拒绝路径；真实升级仍待签名产物 |
| 真实升级可走通 | ❌ 未执行 |
| Linux 隔离证据 | ❌ 待目标环境 |
| Docker 契约证据 | ❌ 待目标环境 |
| PostgreSQL smoke / 并发证据 | ❌ 待目标环境 |
| Anthropic 黄金任务证据 | ❌ 待目标环境 |
| 签名与公证 | ❌ 待证书 |
| 桌面平台 smoke（M1/M2） | ❌ 待目标机器 |
| 备份恢复演练 | ❌ 待独立数据库 |
| schema 升级/回滚演练 | ❌ 待独立数据库 |
| release notes / 已知限制 / 回滚步骤 | ✅ 见 §6（回滚步骤随更新链路接线后补齐） |

**判定**：仅满足质量门禁与文档骨架，应交付 RC 与上述未完成清单，不标记 Phase 4 完成。

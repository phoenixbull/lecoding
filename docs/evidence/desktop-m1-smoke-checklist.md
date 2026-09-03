# 桌面端 M1 安装包人工验收清单

更新日期：2026-09-02
适用范围：[latest-development-plan.md](../latest-development-plan.md) § 6 M1.3 的真实平台黄金 smoke

## 1. 这份清单为什么存在

M1.3 把桌面端到端测试拆成两层：

| 层 | 覆盖面 | 执行方式 | 可复现性 |
|---|---|---|---|
| 深业务 E2E | 设备绑定、Run 创建、SSE 恢复、审批、Diff、验证、取消、keep/discard、设备撤销、不受信 sender / 导航 / 弹窗阻断 | 自动化（`apps/desktop/test/run-loop.integration.test.ts`） | CI 上确定可复现 |
| 真实平台黄金 smoke | 安装后客户端能启动、能连上、能完成一次真实闭环 | 本清单；`installed-app.smoke.test.ts` 仅提供产物结构证据 | 需在真实 Windows / macOS 上人工执行 |

不要求真实 Electron GUI 覆盖全部分支：headless Electron 在 macOS / Windows runner 上的稳定性不足以作为发布门禁。业务分支由深业务 E2E 以确定性方式覆盖，GUI 层只负责证明「装得起来、连得上、点得动」。

## 2. 自动化前置（每次都必须先过）

```bash
pnpm install --frozen-lockfile
pnpm typecheck                                   # 期望 23/23 workspace 通过
pnpm test                                        # 期望 EXIT=0
pnpm vitest run apps/desktop/test                # 期望桌面端全部通过
```

深业务 E2E 依赖 loopback 监听。受限沙箱中它会**显式跳过**并打印原因，不是业务失败：

```bash
pnpm vitest run apps/desktop/test/run-loop.integration.test.ts
# 允许 loopback 的环境：3 passed
# 禁止 loopback 的环境：3 skipped（原因：loopback listener unavailable: ...）
```

打包产物 smoke（需要真实产物路径，未设置时同样显式跳过）：

```bash
# macOS（.app 路径）
LECODING_INSTALLED_APP_PATH=/path/to/out/LeCoding-darwin-arm64/LeCoding.app \
LECODING_INSTALLED_APP_ARCH=arm64 \
  pnpm vitest run apps/desktop/test/installed-app.smoke.test.ts

# Windows（win-unpacked 目录）
LECODING_INSTALLED_APP_PATH=C:\\path\\to\\out\\LeCoding-win32-x64 \
LECODING_INSTALLED_APP_ARCH=x64 \
  pnpm vitest run apps/desktop/test/installed-app.smoke.test.ts
```

smoke 校验四件事：打包产物内含 `dist/renderer/index.html`、preload 与 main 入口已编译就位、所有原生二进制的实际架构与目标一致、包内版本不是 `0.0.0` 占位符。

## 3. 人工验收清单

每个平台（Windows x64、macOS arm64、macOS x64）各执行一次；三份记录分别归档到
`docs/evidence/desktop-m1-smoke-<platform>-<arch>.md`。

### 3.1 安装

- [ ] 从 GitHub Release 下载对应平台的安装包
- [ ] **Windows**：运行 `LeCoding-Setup-<version>.exe`，完成后「添加或删除程序」里显示为 `LeCoding <version>`
- [ ] **macOS**：打开 `.dmg`，拖入 Applications；首次启动无 Gatekeeper 阻断
- [ ] 启动后窗口标题与底部状态栏显示的版本号与 release tag 一致
- [ ] 记录：安装包文件名、包内版本、系统型号、OS 版本

### 3.2 连接与设备绑定

- [ ] 首次启动显示连接屏（服务器地址 + GitHub 登录 + 访问令牌）
- [ ] 填入 Worker 地址后能拿到项目列表与角色
- [ ] GitHub 登录跳转可用（或改用访问令牌，令牌不足 32 字符时按钮禁用并提示）
- [ ] 生成设备码：9 位等宽大字展示，倒计时可见
- [ ] 输入设备标签后绑定成功；顶栏显示已绑定设备标签
- [ ] 绑定后凭据写入系统钥匙串；顶栏**不出现**降级提示
- [ ] 记录：设备 ID、项目名、凭据后端（系统钥匙串 / 加密文件）

### 3.3 Run 闭环（一次黄金任务）

- [ ] 创建 Run：任务、环境、验收条件、审批模式均可选择（角色决定可选模式）
- [ ] 时间线随 SSE 实时追加，流状态显示「实时连接」
- [ ] 断网 10 秒后自动重连，流状态经历「正在重连」→「实时连接」，事件无重复无丢失
- [ ] 出现审批卡片：目标 / 能力 / 风险 / 原因完整，scope 三档可选
- [ ] 批准（once）后 Run 继续；编辑命令参数后批准后按修改后的 argv 执行
- [ ] 模型提问时用户回答卡片出现，回答后 Run 继续
- [ ] 运行中 steer 追加约束，Agent 在下一个模型回合读取
- [ ] 变更页显示变更文件与统一 Diff，长 Diff 有截断提示
- [ ] 验证证据卡片按 outcome 着色
- [ ] 取消：终态前的任何阶段都能取消，工作区安全清理
- [ ] 成功后的 keep / discard：discard 强制二次确认，执行后源仓库未被修改
- [ ] 记录：Run ID、任务摘要、最终状态、Diff 文件数、验证结果

### 3.4 重启与撤销

- [ ] 完全退出应用后重新打开：已绑定设备自动恢复，历史 Run 可点选恢复
- [ ] 在 Web 端或服务端撤销该设备后，桌面端下一次请求返回设备已撤销，本地凭据被清除并回到连接屏
- [ ] 登出后本地凭据被清除（钥匙串条目消失）
- [ ] 记录：重启前后设备 ID 是否一致、撤销后的错误码与文案

### 3.5 安全回归

- [ ] 外部链接点击后不会在应用内跳转（弹窗被拒绝）
- [ ] 尝试导航到 `https://` 被阻止，窗口停留在打包的 Renderer
- [ ] 应用日志、配置文件、界面上均搜索不到明文设备 token
- [ ] 记录：搜索命令与结果

## 4. 证据归档模板

```markdown
# 桌面端 M1 安装包 smoke — <platform>/<arch>

执行日期：
执行人：
Release tag：
安装包：<文件名>（SHA-256：<摘要>）
Runner 型号与 OS：

## 自动化前置
- pnpm typecheck：<结果>
- pnpm test：<结果>
- installed-app.smoke：<结果>

## 3.1 安装
- 安装方式：
- 包内版本：
- 截图/日志：

## 3.2 连接与设备绑定
- 设备 ID：
- 凭据后端：
- 是否出现降级提示：

## 3.3 Run 闭环
- Run ID：
- 最终状态：
- 审批次数：
- Diff 文件数：
- 验证结果：

## 3.4 重启与撤销
- 重启后设备恢复：
- 撤销后错误码：

## 3.5 安全回归
- 弹窗/导航阻断：
- 明文 token 搜索命令与结果：

## 结论
- [ ] 通过
- 未通过的项与后续处理：
```

## 5. 已知限制

- 本清单不覆盖 M2 的本地 Runner 执行（三档文件权限、WSS 重连、崩溃恢复），那是 Phase 4B 范围。
- 真实代码签名与公证需要外部证书。证书未就绪时产物只能作为 pre-release 发布，不得放行正式版本；详见 `.github/workflows/desktop-release.yml` 的 `release-gate` job。
- 自动更新的「拒绝错误签名 / 错误版本」验证仍在 `apps/desktop/test/auto-update.test.ts` 中以单元测试形式覆盖，真实升级路径需要在 M3 运维演练中补证据。

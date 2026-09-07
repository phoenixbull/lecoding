# M3 证据索引

本目录按**候选（candidate）**组织证据：一个 RC SHA 一个子目录，所有产物、报告、安装与演练记录都引用该 SHA。

```
docs/evidence/m3/<candidate-sha>/
  manifest.md        # 该候选的清单：SHA/tag、日期、执行人、环境版本
  gate/              # 类型检查与全量测试输出
  target-linux/      # 隔离矩阵报告
  docker-contract/   # Docker 公共契约执行结果
  postgres/          # smoke、failover、cancel、steering、并发
  anthropic/         # 黄金任务报告与全部轮次
  desktop/           # 各平台 smoke checklist 与原始记录
  signing/           # 签名与公证验证
  drills/            # 备份恢复、schema 升级回滚、清理告警演练
```

## 目录规则

1. **候选一旦固定就不再改名**。修复引入新 SHA 后，重跑受影响证据及完整门禁，并为新 SHA 建新目录；不把不同 SHA 的证据混进同一目录。
2. **未执行的项目不建文件**。留空即为「待目标环境」，不得用占位文件暗示已完成。
3. **日志脱敏**：凭据、token、数据库连接串不入库。数据库备份文件不入库。
4. **跳过必须写明原因**：任何跳过都记录触发条件与所需环境，不记为通过。

## 每个证据文件的必填字段

填入下述模板；缺任何一项即视为该证据不完整。

```markdown
### <验证项>
- 候选 SHA / tag:
- 执行人 / 日期:
- 环境: OS + 版本 + 架构；Node / pnpm 版本；Docker / PostgreSQL 版本（如适用）
- 命令:
- 退出码:
- 结果: 通过 / 失败 / 跳过
- 跳过原因（如适用）:
- 关键输出: 通过 / 跳过 / 失败 数量；本次结论所依赖的具体断言
- 原始日志: <路径或链接>
- 备注: 与预期的偏差、后续影响
```

## 不得出现的表述

- 「全部通过」但存在未列出的跳过。
- 用内存/PGlite 结果充当真实 PostgreSQL 证据。
- 用进程创建前的 argv 拦截充当内核级拒绝证据。
- macOS 上写 Job Object（Windows 无此实现）。
- 只归档成功的黄金任务轮次。

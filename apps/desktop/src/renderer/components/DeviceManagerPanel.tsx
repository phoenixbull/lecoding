import { formatProjectPolicyRule } from "@lecoding/presentation";
import type { RunConsoleController, RunConsoleState } from "@lecoding/run-controller";

export interface DeviceManagerPanelProps {
  controller: RunConsoleController;
  state: RunConsoleState;
  onConfirmAction: (message: string) => boolean;
}

/** Devices, credential health, session control, and project policy rules. */
export function DeviceManagerPanel({
  controller,
  state,
  onConfirmAction
}: DeviceManagerPanelProps) {
  const credential = state.credential;

  return (
    <div className="column">
      <section className="panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Devices</p>
            <h3>已绑定设备</h3>
          </div>
          <button
            className="secondary-button compact"
            type="button"
            onClick={() => {
              void controller.refreshDevices();
            }}
          >
            刷新
          </button>
        </div>
        {state.devices.length === 0 ? (
          <p className="empty-state">这台机器还没有绑定设备。</p>
        ) : (
          <div>
            {state.devices.map((device) => (
              <div key={device.deviceId} className="device-row">
                <div className="device-meta">
                  <strong>{device.deviceLabel}</strong>
                  <span>
                    {device.platform} · {device.projectName} · 过期于{" "}
                    {new Date(device.expiresAt).toLocaleDateString("zh-CN")}
                  </span>
                </div>
                <button
                  className="danger-button compact"
                  type="button"
                  onClick={() => {
                    if (
                      onConfirmAction(
                        `确认撤销设备「${device.deviceLabel}」？该设备的本地凭据会被立即清除。`
                      )
                    ) {
                      void controller.revokeDevice(device.deviceId);
                    }
                  }}
                >
                  撤销
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Credential storage</p>
            <h3>凭据存储</h3>
          </div>
        </div>
        {credential ? (
          <div className="stack">
            <div className="device-row">
              <div className="device-meta">
                <strong>
                  {credential.backend === "safeStorage"
                    ? "操作系统安全存储"
                    : "加密文件（降级）"}
                </strong>
                <span>{credential.reason ?? "设备令牌由操作系统密钥保护。"}</span>
              </div>
              <span
                className="status-badge"
                data-status={credential.degraded ? "failed" : "succeeded"}
              >
                {credential.degraded ? "已降级" : "正常"}
              </span>
            </div>
            {credential.expiresAt ? (
              <p className="muted">
                凭据过期时间：
                {new Date(credential.expiresAt).toLocaleString("zh-CN", {
                  hour12: false
                })}
              </p>
            ) : null}
          </div>
        ) : (
          <p className="empty-state">正在读取凭据存储状态…</p>
        )}
        <div className="row-actions" style={{ marginTop: 12 }}>
          <button
            className="danger-button"
            type="button"
            onClick={() => {
              if (onConfirmAction("确认登出？本地保存的设备凭据会被清除。")) {
                void controller.logout();
              }
            }}
          >
            登出并清除本地凭据
          </button>
        </div>
      </section>

      {state.policyRulesVisible ? (
        <section className="panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Project policy</p>
              <h3>项目审批规则</h3>
            </div>
          </div>
          <p className="muted">仅管理员可见；撤销后新的能力请求将重新进入审批。</p>
          {state.policyRules.length === 0 ? (
            <p className="empty-state">当前没有生效中的项目规则。</p>
          ) : (
            <div>
              {state.policyRules.map((rule) => {
                const details = formatProjectPolicyRule(rule);
                return (
                  <div key={details.id} className="policy-rule-row">
                    <span className="mono">
                      {details.capability} · {details.decision} · {details.fingerprint}
                    </span>
                    <button
                      className="secondary-button compact"
                      type="button"
                      onClick={() => {
                        void controller.revokePolicyRule(details.id);
                      }}
                    >
                      撤销
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}

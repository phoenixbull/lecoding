import { useEffect, useState } from "react";
import type { RunConsoleController, RunConsoleState } from "@lecoding/run-controller";

/** Connection and binding commands supplied by the production composition root. */
export interface ConnectionScreenProps {
  controller: RunConsoleController;
  state: RunConsoleState;
  platform: "darwin" | "win32" | "linux";
  /** Opens the GitHub sign-in flow; the desktop delegates it to the OS shell. */
  onGitHubLogin: (serverUrl: string) => void;
  onConnect: (serverUrl: string) => void;
}

/**
 * Connection and device-binding screen.
 *
 * Shown whenever the console is not authenticated. Two binding directions are
 * supported because the operator may start from either surface:
 *   - Web-first: paste a code the logged-in Web console minted.
 *   - Desktop-first: mint a code here and approve it in the browser.
 */
export function ConnectionScreen({
  controller,
  state,
  platform,
  onGitHubLogin,
  onConnect
}: ConnectionScreenProps) {
  const [serverUrl, setServerUrl] = useState("http://127.0.0.1:8787");
  const [deviceLabel, setDeviceLabel] = useState("");
  const [code, setCode] = useState("");

  // Refresh once per mount so the bound-device list is not refetched on every
  // keystroke in the form below.
  useEffect(() => {
    void controller.refreshDevices();
  }, [controller]);

  const busy = state.binding;
  const canExchangeWebCode = state.phase !== "loading";

  return (
    <div className="connect-screen">
      <div className="connect-card stack">
        <section className="panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Control plane</p>
              <h2>连接 LeCoding Worker</h2>
            </div>
          </div>
          <div className="field">
            <label htmlFor="server-url-input">服务器地址</label>
            <input
              id="server-url-input"
              value={serverUrl}
              disabled={state.phase === "loading"}
              onChange={(event) => {
                setServerUrl(event.target.value);
              }}
            />
            <small>桌面端通过该地址访问 Worker 的 HTTP 与 SSE 接口。</small>
          </div>
          <div className="row-actions">
            <button
              className="primary-button"
              type="button"
              disabled={state.phase === "loading" || serverUrl.trim() === ""}
              onClick={() => {
                onConnect(serverUrl.trim());
              }}
            >
              连接
            </button>
            <button
              className="secondary-button"
              type="button"
              disabled={serverUrl.trim() === ""}
              onClick={() => {
                onGitHubLogin(serverUrl.trim());
              }}
            >
              使用 GitHub 登录
            </button>
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Device binding</p>
              <h3>绑定这台设备</h3>
            </div>
          </div>
          <div className="field">
            <label htmlFor="device-label-input">设备名称</label>
            <input
              id="device-label-input"
              value={deviceLabel}
              disabled={busy}
              placeholder="例如：office-mac"
              onChange={(event) => {
                setDeviceLabel(event.target.value);
              }}
            />
          </div>

          <div className="field">
            <label htmlFor="device-code-input">网页端生成的设备码</label>
            <input
              id="device-code-input"
              className="mono"
              value={code}
              disabled={busy || !canExchangeWebCode}
              placeholder="在已登录的 Web 控制台生成后粘贴到这里"
              onChange={(event) => {
                setCode(event.target.value);
              }}
            />
            <small>设备码一次性使用；绑定成功后本地凭据由操作系统安全存储保存。</small>
          </div>
          <div className="row-actions">
            <button
              className="primary-button"
              type="button"
              disabled={busy || !canExchangeWebCode || code.trim() === ""}
              onClick={() => {
                void controller.bindDevice({ code, deviceLabel, platform });
              }}
            >
              绑定设备
            </button>
            <button
              className="secondary-button"
              type="button"
              disabled={busy || state.phase !== "ready"}
              onClick={() => {
                void controller.createDeviceCode();
              }}
            >
              改为在本机生成
            </button>
          </div>

          {state.deviceCode ? (
            <div className="stack" style={{ marginTop: 12 }}>
              <div className="device-code" aria-live="polite">
                {state.deviceCode.code}
              </div>
              <p className="muted">
                在已登录的浏览器中批准此设备码；过期时间{" "}
                {new Date(state.deviceCode.expiresAt).toLocaleString("zh-CN", {
                  hour12: false
                })}
                。批准后点击「绑定设备」完成本机绑定。
              </p>
            </div>
          ) : null}
        </section>

        {state.devices.length > 0 ? (
          <section className="panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Already bound</p>
                <h3>本机已绑定设备</h3>
              </div>
            </div>
            {state.devices.map((device) => (
              <div key={device.deviceId} className="device-row">
                <div className="device-meta">
                  <strong>{device.deviceLabel}</strong>
                  <span>
                    {device.platform} · {device.projectName}
                  </span>
                </div>
                <button
                  className="danger-button compact"
                  type="button"
                  onClick={() => {
                    void controller.revokeDevice(device.deviceId);
                  }}
                >
                  撤销
                </button>
              </div>
            ))}
          </section>
        ) : null}
      </div>
    </div>
  );
}

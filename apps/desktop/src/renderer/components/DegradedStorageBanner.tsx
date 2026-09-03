import type { RunConsoleState } from "@lecoding/run-controller";

export interface DegradedStorageBannerProps {
  state: RunConsoleState;
}

/**
 * Persistent warning that the OS keychain is not protecting the credential.
 *
 * A silent degradation would be the worst outcome here: the user would keep
 * using the device token believing it is sealed by the OS, when it is only
 * protected by a passphrase file. So the banner stays until the backend
 * recovers.
 */
export function DegradedStorageBanner({ state }: DegradedStorageBannerProps) {
  const credential = state.credential;
  if (!credential?.degraded) {
    return null;
  }
  return (
    <div className="banner" data-tone="warning" role="status">
      <span>
        凭据存储已降级为加密文件（{credential.reason ?? "系统安全存储不可用"}）。
        设备令牌不再由操作系统保护，请在支持的系统钥匙串上重新绑定设备。
      </span>
    </div>
  );
}

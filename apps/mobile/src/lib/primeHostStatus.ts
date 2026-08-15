export type PrimeHostStatus = "ready" | "auth" | "compatibility" | "crash" | "offline";
export type PrimeHostPresentation = { readonly title: string; readonly detail: string; readonly action: string; };
export function presentPrimeHostStatus(status: PrimeHostStatus, detail?: string): PrimeHostPresentation {
 const map: Record<PrimeHostStatus, PrimeHostPresentation> = {
  ready: { title: "Prime host connected", detail: detail || "Remote host is ready.", action: "Continue" },
  auth: { title: "Authenticate on the remote host", detail: detail || "Sign in to Prime on the host, then refresh this connection.", action: "Refresh connection" },
  compatibility: { title: "Update the remote host", detail: detail || "This Prime host is not compatible with the current app.", action: "Refresh connection" },
  crash: { title: "Prime host stopped unexpectedly", detail: detail || "Restart the remote host, then retry.", action: "Retry" },
  offline: { title: "Remote host unavailable", detail: detail || "Check the remote host connection and retry.", action: "Retry" },
 };
 return map[status];
}

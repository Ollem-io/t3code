import type { ServerConfig } from "@t3tools/contracts";

export type PrimeHostStatus = "ready" | "auth" | "compatibility" | "crash" | "offline";
export type PrimeHostPresentation = {
  readonly title: string;
  readonly detail: string;
  readonly action: string;
};

export function presentPrimeHostStatus(
  status: PrimeHostStatus,
  detail?: string,
): PrimeHostPresentation {
  const map: Record<PrimeHostStatus, PrimeHostPresentation> = {
    ready: { title: "Prime host connected", detail: detail || "Remote host is ready.", action: "" },
    auth: {
      title: "Prime authentication required on host",
      detail: detail || "Sign in to Prime on the remote host, then refresh this connection.",
      action: "Open connection settings",
    },
    compatibility: {
      title: "Prime host update required",
      detail: detail || "Update Prime Agent on the remote host, then refresh this connection.",
      action: "Open connection settings",
    },
    crash: {
      title: "Prime Agent stopped on host",
      detail:
        detail ||
        "Prime Agent stopped unexpectedly on the remote host. Retry after the host recovers.",
      action: "Retry connection",
    },
    offline: {
      title: "Prime host unavailable",
      detail: detail || "Check the remote host connection and retry.",
      action: "Retry connection",
    },
  };
  return map[status];
}

export function primeHostPresentationForSelection(
  config: ServerConfig | null | undefined,
  instanceId: string,
  sessionError?: string | null,
): PrimeHostPresentation | null {
  const provider = config?.providers.find((candidate) => candidate.instanceId === instanceId);
  if (!provider || provider.driver !== "prime-agent") return null;
  if (sessionError || provider.status === "error")
    return presentPrimeHostStatus("crash", sessionError ?? provider.message);
  if (provider.compatibility === "incompatible")
    return presentPrimeHostStatus("compatibility", provider.message);
  if (provider.auth.status === "unauthenticated")
    return presentPrimeHostStatus("auth", provider.message);
  if (
    !provider.enabled ||
    !provider.installed ||
    provider.availability === "unavailable" ||
    provider.status === "disabled"
  ) {
    return presentPrimeHostStatus("offline", provider.unavailableReason ?? provider.message);
  }
  return provider.status === "ready" ? null : presentPrimeHostStatus("offline", provider.message);
}

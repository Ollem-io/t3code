// PA-M14 source-derived Prime thread workflow state artifact.
// Dependency-free: this describes renderer-owned presentation state only.
export const seedInstructions = Object.freeze({
  app: "test-t3-app",
  steps: ["Seed two Prime instances with colliding display names", "Bind a thread to each instance", "Exercise stale, unavailable, crash, retry, checkpoint, and attachment states", "Verify interrupt/continue/stop and confirmed session switch copy"],
  prohibited: ["browser screenshots", "simulator", "renderer process ownership", "process paths", "secrets", "silent provider fallback"],
});

const CAPABILITY_LABELS = Object.freeze({ reasoning: "Reasoning", vision: "Vision", tools: "Tools", attachments: "Attachments", thinking: "Thinking" });
export function structuredInstanceLabel(instance) {
  const name = String(instance?.displayName || instance?.driver || "Prime Agent").trim();
  const suffix = instance?.instanceId ? ` · ${instance.instanceId}` : "";
  return `${name}${suffix}`;
}
export function modelPresentation(model, instance) {
  const capabilities = (model?.capabilities || []).map((x) => CAPABILITY_LABELS[x] || x);
  return { label: String(model?.displayName || model?.id || "Unknown model"), instanceLabel: structuredInstanceLabel(instance), capabilities, thinking: model?.thinking ?? "unknown", available: model?.availability === "available" };
}
export function resolveBoundSelection({ instanceId, modelId, instances = [] }) {
  const instance = instances.find((x) => x.instanceId === instanceId);
  if (!instance || instance.availability === "unavailable") return { ok: false, reason: "bound-instance-unavailable" };
  const model = (instance.models || []).find((x) => x.id === modelId);
  if (!model || model.availability !== "available") return { ok: false, reason: "bound-model-unavailable" };
  return { ok: true, instanceId, modelId };
}
export function collisionDistinctLabels(instances) {
  const counts = new Map(); instances.forEach((x) => counts.set(x.displayName, (counts.get(x.displayName) || 0) + 1));
  return instances.map((x) => counts.get(x.displayName) > 1 ? `${x.displayName} · ${x.instanceId}` : x.displayName);
}
export function sessionSwitchPresentation({ from, to, activeTurn = false }) {
  const destination = structuredInstanceLabel(to);
  return { requiresConfirmation: Boolean(activeTurn || from?.instanceId !== to?.instanceId), title: `Switch to ${destination}?`, description: activeTurn ? "The active turn will be stopped before switching. Thread history is retained." : `This thread will use ${destination}. Thread history is retained.`, confirmLabel: "Switch session" };
}
export function attachmentValidation(attachments, limits = { maxCount: 10, maxBytes: 10 * 1024 * 1024 }) {
  const list = attachments || [];
  if (list.length > limits.maxCount) return { ok: false, reason: "too-many-attachments" };
  const invalid = list.find((a) => !a || !a.name || !Number.isFinite(a.bytes) || a.bytes < 0 || a.bytes > limits.maxBytes || !String(a.type || "").startsWith("image/"));
  return invalid ? { ok: false, reason: invalid.bytes > limits.maxBytes ? "attachment-too-large" : "invalid-attachment" } : { ok: true };
}
export function composerStatus({ phase = "idle", prompt = "", attachments = [], error = null }) {
  const valid = attachmentValidation(attachments).ok;
  if (error) return { tone: "error", label: "Retry available", canSend: false, message: error };
  if (!valid) return { tone: "warning", label: "Attachment needs attention", canSend: false };
  if (phase === "running") return { tone: "active", label: "Prime Agent is working", canSend: false };
  if (phase === "stopped") return { tone: "neutral", label: "Stopped", canSend: Boolean(prompt.trim() || attachments.length) };
  return { tone: "ready", label: "Ready", canSend: Boolean(prompt.trim() || attachments.length) };
}
export function canonicalActivity(event) {
  const type = event?.type || "runtime.warning";
  const labels = { "turn.started": "Turn started", "turn.completed": "Turn completed", "turn.aborted": "Turn stopped", "item.started": "Activity started", "item.completed": "Activity completed", "request.opened": "Input requested", "request.resolved": "Input resolved", "runtime.error": "Runtime error", "runtime.warning": "Runtime warning" };
  return { type, label: labels[type] || "Activity", detail: event?.detail || null, interaction: Boolean(type.startsWith("request.")) };
}
export function controlAvailability({ phase, crashed = false }) {
  if (crashed) return { interrupt: false, continue: false, stop: false, retry: true };
  return { interrupt: phase === "running", continue: phase === "stopped" || phase === "paused", stop: phase === "running" || phase === "paused", retry: phase === "error" };
}
export function checkpointPresentation() { return { disclaimer: "Checkpoint restores the saved workspace state; it does not rewind or delete thread history.", canRestore: true }; }
export const providerNeutralPalette = Object.freeze({ actions: { interrupt: "Mod+I", continue: "Mod+Enter", stop: "Escape", retry: "Mod+R" }, colors: { active: "accent", warning: "warning", error: "destructive" } });

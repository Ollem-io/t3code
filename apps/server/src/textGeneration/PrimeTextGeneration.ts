// @effect-diagnostics nodeBuiltinImport:off
import { randomUUID } from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { PrimeAgentSettings, ProviderInstanceId, ChatAttachment, ModelSelection } from "@t3tools/contracts";
import { TextGenerationError, ThreadId } from "@t3tools/contracts";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { primeResourceLayout } from "../provider/prime/PrimeResourceLayout.ts";
import { writePrimeOwnership } from "../provider/prime/PrimeOwnership.ts";
import { PrimeRpcClient } from "../provider/prime/PrimeRpcClient.ts";
import { spawnPrimeRpcTransport } from "../provider/prime/PrimeRpcProcessTransport.ts";
import * as TextGeneration from "./TextGeneration.ts";
import { buildBranchNamePrompt, buildCommitMessagePrompt, buildPrContentPrompt, buildThreadTitlePrompt } from "./TextGenerationPrompts.ts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { sanitizeCommitSubject, sanitizePrTitle, sanitizeThreadTitle } from "./TextGenerationUtils.ts";

const TIMEOUT_MS = 45_000, MAX_EVENTS = 512, MAX_OUTPUT = 1024 * 1024, MAX_IMAGE = 10 * 1024 * 1024;
type Op = "generateCommitMessage" | "generatePrContent" | "generateBranchName" | "generateThreadTitle";
const fail = (operation: Op, detail: string, cause?: unknown) => new TextGenerationError({ operation, detail, ...(cause === undefined ? {} : { cause }) });
const appendText = (v: unknown, out: string[]): void => {
  if (typeof v === "string") { out.push(v); return; }
  if (Array.isArray(v)) { for (const x of v) appendText(x, out); return; }
  if (!v || typeof v !== "object") return;
  const x = v as Record<string, unknown>;
  if (typeof x.text === "string") out.push(x.text);
  else if (typeof x.delta === "string") out.push(x.delta);
  else if (x.content !== undefined) appendText(x.content, out);
};
const contained = (root: string, child: string) => { const r = relative(resolve(root), resolve(child)); return r === "" || (!r.startsWith("..") && !isAbsolute(r)); };
export interface PrimeTextGenerationOptions { readonly instanceId: ProviderInstanceId; readonly environment?: NodeJS.ProcessEnv; readonly timeoutMs?: number; }
export const makePrimeTextGeneration = Effect.fn("makePrimeTextGeneration")(function* (settings: PrimeAgentSettings, options: PrimeTextGenerationOptions) {
  const cfg = yield* ServerConfig.ServerConfig; const environment = yield* ServerEnvironment; const environmentId = yield* environment.getEnvironmentId; const env = options.environment ?? process.env;
  const run = async <T>(operation: Op, cwd: string, prompt: string, selection: ModelSelection, outputSchema: Schema.Top, convert: (x: Record<string, unknown>) => T, attachments?: ReadonlyArray<ChatAttachment>): Promise<T> => {
    if (!selection.nativeIdentity || selection.instanceId !== options.instanceId) throw fail(operation, "A valid Prime native model identity is required.");
    let cwdReal: string; try { cwdReal = await realpath(cwd); const s = await stat(cwdReal); if (!s.isDirectory()) throw Error("cwd is not a directory"); } catch (e) { throw fail(operation, "Invalid working directory.", e); }
    const threadId = ThreadId.make(`text-generation-${randomUUID()}`); const layout = primeResourceLayout({ home: cfg.stateDir, environmentId: String(environmentId), instanceId: String(options.instanceId), threadId: String(threadId) });
    await NodeFSP.mkdir(layout.session, { recursive: true, mode: 0o700 }); await NodeFSP.mkdir(`${layout.session}/tmp`, { recursive: true, mode: 0o700 });
    const record = { version: 1 as const, environmentId: String(environmentId), instanceId: String(options.instanceId), threadId: String(threadId), kind: "thread" as const, operationId: randomUUID() };
    await writePrimeOwnership(layout.ownership, record);
    const safeEnv: NodeJS.ProcessEnv = { PATH: env.PATH, HOME: layout.session, USERPROFILE: layout.session, TMPDIR: `${layout.session}/tmp`, TEMP: `${layout.session}/tmp`, XDG_CONFIG_HOME: `${layout.session}/.config`, XDG_DATA_HOME: `${layout.session}/.local/share`, XDG_STATE_HOME: `${layout.session}/.local/state` };
    const transport = spawnPrimeRpcTransport(settings.binaryPath, ["--mode", "rpc", "--session-dir", layout.session], { cwd: cwdReal, env: safeEnv });
    const processIdentity = await transport.processIdentityReady?.catch(() => undefined);
    if (processIdentity) await writePrimeOwnership(layout.ownership, { ...record, process: processIdentity });
    const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
    const client = new PrimeRpcClient(transport, { requestIdPrefix: "t3-prime-text", defaultTimeoutMs: timeoutMs }); const controller = new AbortController(); let deadlineReject!: (error: Error) => void; const deadline = new Promise<never>((_, reject) => { deadlineReject = reject; }); const timer = setTimeout(() => { controller.abort(); deadlineReject(new Error("Prime text generation timed out")); void transport.stopExact?.(processIdentity!).catch(() => undefined); void Promise.resolve(transport.close?.()).catch(() => undefined); }, timeoutMs); const chunks: string[] = []; let ended = false;
    try {
      const ready = await client.command({ type: "get_state" }, { signal: controller.signal }); if (!ready.success) throw Error("Prime RPC readiness failed");
      const identity = selection.nativeIdentity; const listed = await client.command({ type: "get_available_models" }, { signal: controller.signal });
      if (!listed.success || listed.command !== "get_available_models") throw Error("Prime model listing failed");
      const model = listed.data.models.find((m) => m.provider === identity.provider && m.id === identity.modelId); if (!model || !model.input.includes("text")) throw Error("Requested Prime model is unavailable or lacks text capability");
      if ((attachments ?? []).some((a) => a.type === "image") && !model.input.includes("image")) throw Error("Requested Prime model lacks image capability");
      const selected = await client.command({ type: "set_model", provider: identity.provider, modelId: identity.modelId }, { signal: controller.signal }); if (!selected.success) throw Error("Prime model selection failed");
      const images: Array<{type:"image";data:string;mimeType:string}> = [];
      for (const a of attachments ?? []) if (a.type === "image") { const path = resolveAttachmentPath({ attachmentsDir: cfg.attachmentsDir, attachment: a }); if (!path || !contained(cfg.attachmentsDir, path)) throw Error("Invalid attachment path"); const real = await realpath(path); const st = await stat(real); if (!st.isFile() || !contained(cfg.attachmentsDir, real) || st.size > MAX_IMAGE || !/^image\//i.test(a.mimeType)) throw Error("Invalid image attachment"); images.push({ type: "image", data: (await NodeFSP.readFile(real)).toString("base64"), mimeType: a.mimeType }); }
      const response = await client.command({ type: "prompt", message: prompt, ...(images.length ? { images } : {}) }, { signal: controller.signal }); if (!response.success) throw Error("Prime prompt failed");
      let events = 0; let updateSnapshot = ""; const iterator = client.events(); for (;;) { const result = await Promise.race([iterator.next(), deadline]); if (result.done) break; const envelope = result.value; if (++events > MAX_EVENTS) throw Error("Prime emitted too many events"); if (envelope._tag === "malformed" || envelope._tag === "unknown-event" || envelope._tag === "command" || envelope._tag === "response") throw Error("Prime emitted malformed or unexpected event"); const event = envelope.value as { type: string; message?: unknown; assistantMessageEvent?: unknown }; if (event.type === "message_update") { const values: string[] = []; appendText(event.assistantMessageEvent ?? event.message, values); const delta = values.join(""); updateSnapshot += delta; chunks.push(delta); } else if (event.type === "message_end") { const values: string[] = []; appendText(event.message, values); const text = values.join(""); if (text !== updateSnapshot) chunks.push(text); updateSnapshot = ""; } else if (event.type === "turn_end") { ended = true; break; } }
      const output = chunks.join(""); if (!ended || output.length === 0 || output.length > MAX_OUTPUT) throw Error("Prime returned incomplete or oversized output");
      const match = output.match(/\{[\s\S]*\}/); if (!match) throw Error("Prime returned malformed structured output"); const parsed: unknown = JSON.parse(match[0]); const decoded = Schema.decodeUnknownSync(outputSchema)(parsed); return convert(decoded as Record<string, unknown>);
    } catch (cause) { if (cause instanceof TextGenerationError) throw cause; throw fail(operation, "Prime Agent text-generation request failed.", cause); }
    finally { clearTimeout(timer); controller.abort(); client.close(); await Promise.resolve(transport.close?.()).catch(() => undefined); const terminal = await transport.terminal.catch(() => undefined); if (terminal && processIdentity) { try { await writePrimeOwnership(layout.ownership, { ...record, process: processIdentity, processStopped: true, rpcCleaned: true, resourcesCleaned: false }); } catch {} } }
  };
  const runPrompt = <T>(op: Op, cwd: string, selection: ModelSelection, built: {prompt:string; outputSchema: Schema.Top}, convert: (x: Record<string, unknown>) => T, attachments?: ReadonlyArray<ChatAttachment>) => Effect.tryPromise({ try: () => run(op,cwd,built.prompt,selection,built.outputSchema,convert,attachments), catch: (e) => e instanceof TextGenerationError ? e : fail(op,"Prime Agent text generation failed.",e) });
  return { generateCommitMessage: (i: TextGeneration.CommitMessageGenerationInput) => { const b=buildCommitMessagePrompt(i); return runPrompt("generateCommitMessage",i.cwd,i.modelSelection,b,x=>({subject:sanitizeCommitSubject(x.subject as string),body:x.body as string,...(i.includeBranch ? {branch:sanitizeFeatureBranchName(x.branch as string)} : {})})); }, generatePrContent: (i: TextGeneration.PrContentGenerationInput) => { const b=buildPrContentPrompt(i); return runPrompt("generatePrContent",i.cwd,i.modelSelection,b,x=>({title:sanitizePrTitle(x.title as string),body:x.body as string})); }, generateBranchName: (i: TextGeneration.BranchNameGenerationInput) => { const b=buildBranchNamePrompt(i); return runPrompt("generateBranchName",i.cwd,i.modelSelection,b,x=>({branch:sanitizeFeatureBranchName(sanitizeBranchFragment(x.branch as string))}),i.attachments); }, generateThreadTitle: (i: TextGeneration.ThreadTitleGenerationInput) => { const b=buildThreadTitlePrompt(i); return runPrompt("generateThreadTitle",i.cwd,i.modelSelection,b,x=>({title:sanitizeThreadTitle(x.title as string)}),i.attachments); } } satisfies TextGeneration.TextGeneration["Service"];
});

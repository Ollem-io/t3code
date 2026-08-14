// @effect-diagnostics nodeBuiltinImport:off
import { randomUUID } from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { stat, lstat, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { PrimeAgentSettings, ProviderInstanceId, ChatAttachment, ModelSelection } from "@t3tools/contracts";
import { TextGenerationError, ThreadId } from "@t3tools/contracts";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { primeResourceLayout } from "../provider/prime/PrimeResourceLayout.ts";
import { cleanupPrimeOwnership, writePrimeOwnership, type PrimeOwnershipProof, type PrimeOwnershipCleanup, type PrimeOwnedResource } from "../provider/prime/PrimeOwnership.ts";
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

/** Safely removes one exact disposable inode by quarantine rename. */
const makeExactRemover = async (resource: PrimeOwnedResource): Promise<"removed" | "retained"> => {
  const path = resolve(resource.path);
  const parent = resolve(path, "..");
  const parentReal = await realpath(parent);
  if (!contained(parentReal, path) || resolve(dirname(path)) !== parent) return "retained";
  let before;
  try { before = await lstat(path, { bigint: true }); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return "removed"; throw e; }
  if (before.isSymbolicLink() || String(before.dev) !== resource.identity.dev || String(before.ino) !== resource.identity.ino) return "retained";
  const quarantine = join(parent, `.${basename(path)}.quarantine-${randomUUID()}`);
  try {
    const check = await lstat(path, { bigint: true });
    if (check.isSymbolicLink() || check.dev !== before.dev || check.ino !== before.ino) return "retained";
    await rename(path, quarantine);
    const moved = await lstat(quarantine, { bigint: true });
    if (moved.isSymbolicLink() || moved.dev !== before.dev || moved.ino !== before.ino) return "retained";
    await rm(quarantine, { recursive: true, force: false });
    return "removed";
  } catch { return "retained"; }
};

export interface PrimeTextGenerationOptions { readonly instanceId: ProviderInstanceId; readonly environment?: NodeJS.ProcessEnv; readonly timeoutMs?: number; readonly launch?: typeof spawnPrimeRpcTransport; }
export const makePrimeTextGeneration = Effect.fn("makePrimeTextGeneration")(function* (settings: PrimeAgentSettings, options: PrimeTextGenerationOptions) {
  const cfg = yield* ServerConfig.ServerConfig; const environment = yield* ServerEnvironment; const environmentId = yield* environment.getEnvironmentId; const env = options.environment ?? process.env;
  const run = async <T>(operation: Op, cwd: string, prompt: string, selection: ModelSelection, outputSchema: Schema.Codec<any, any, never>, convert: (x: Record<string, unknown>) => T, attachments?: ReadonlyArray<ChatAttachment>): Promise<T> => {
    if (!selection.nativeIdentity || selection.instanceId !== options.instanceId) throw fail(operation, "A valid Prime native model identity is required.");
    let cwdReal: string; try { cwdReal = await realpath(cwd); const s = await stat(cwdReal); if (!s.isDirectory()) throw Error("cwd is not a directory"); } catch (e) { throw fail(operation, "Invalid working directory.", e); }
    let layout: ReturnType<typeof primeResourceLayout> | undefined;
    let record: any;
    let transport: any;
    let processIdentity: any;
    let client: PrimeRpcClient | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let deadline: Promise<never> = new Promise(() => undefined);
    const chunks: string[] = []; let ended = false;
    const finalize = async () => {
      if (timer) clearTimeout(timer); controller?.abort(); client?.close();
      try {
        if (transport && processIdentity) { try { await transport.stopExact?.(processIdentity); } catch {} }
        await Promise.resolve(transport?.close?.()).catch(() => undefined);
        await transport?.terminal?.catch(() => undefined);
        if (layout && record) {
          if (processIdentity) {
            try { record = { ...record, process: processIdentity, processStopped: true }; await writePrimeOwnership(layout.ownership, record); } catch {}
          }
          const proof: PrimeOwnershipProof = { processMatches: async () => false };
          const cleanup: PrimeOwnershipCleanup = { stopProcess: async () => { throw new Error("process was not marked stopped"); }, removeOwnedResource: makeExactRemover };
          await cleanupPrimeOwnership(layout.ownership, proof, cleanup);
        }
      } catch {}
    };
    try {
      const threadId = ThreadId.make(`text-generation-${randomUUID()}`);
      layout = primeResourceLayout({ home: cfg.stateDir, environmentId: String(environmentId), instanceId: String(options.instanceId), threadId: String(threadId) });
      await NodeFSP.mkdir(layout.session, { recursive: true, mode: 0o700 }); await NodeFSP.mkdir(`${layout.session}/tmp`, { recursive: true, mode: 0o700 });
      record = { version: 1 as const, environmentId: String(environmentId), instanceId: String(options.instanceId), threadId: String(threadId), kind: "thread" as const, operationId: randomUUID() };
      await writePrimeOwnership(layout.ownership, record);
      const safeEnv: NodeJS.ProcessEnv = { PATH: env.PATH, HOME: layout.session, USERPROFILE: layout.session, TMPDIR: `${layout.session}/tmp`, TEMP: `${layout.session}/tmp`, XDG_CONFIG_HOME: `${layout.session}/.config`, XDG_DATA_HOME: `${layout.session}/.local/share`, XDG_STATE_HOME: `${layout.session}/.local/state` };
      transport = (options.launch ?? spawnPrimeRpcTransport)(settings.binaryPath, ["--mode", "rpc", "--session-dir", layout.session], { cwd: cwdReal, env: safeEnv });
      processIdentity = await transport.processIdentityReady?.catch(() => undefined);
      if (processIdentity) { record = { ...record, process: processIdentity }; await writePrimeOwnership(layout.ownership, record); }
      const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
      client = new PrimeRpcClient(transport, { requestIdPrefix: "t3-prime-text", defaultTimeoutMs: timeoutMs }); controller = new AbortController(); let deadlineReject!: (error: Error) => void; deadline = new Promise<never>((_, reject) => { deadlineReject = reject; }); void deadline.catch(() => undefined); timer = setTimeout(() => { controller?.abort(); deadlineReject(new Error("Prime text generation timed out")); }, timeoutMs);
    } catch (cause) { await finalize(); throw fail(operation, "Prime Agent text-generation setup failed.", cause); }
    try {
      const ready = await client!.command({ type: "get_state" }, { signal: controller!.signal }); if (!ready.success) throw Error("Prime RPC readiness failed");
      const identity = selection.nativeIdentity; const listed = await client!.command({ type: "get_available_models" }, { signal: controller!.signal });
      if (!listed.success || listed.command !== "get_available_models") throw Error("Prime model listing failed");
      const models = (listed as { readonly data: { readonly models: ReadonlyArray<{ readonly provider: string; readonly id: string; readonly input: ReadonlyArray<"text" | "image"> }> } }).data.models; const model = models.find((m) => m.provider === identity.provider && m.id === identity.modelId); if (!model || !model.input.includes("text")) throw Error("Requested Prime model is unavailable or lacks text capability");
      if ((attachments ?? []).some((a) => a.type === "image") && !model.input.includes("image")) throw Error("Requested Prime model lacks image capability");
      const selected = await client!.command({ type: "set_model", provider: identity.provider, modelId: identity.modelId }, { signal: controller!.signal }); if (!selected.success) throw Error("Prime model selection failed");
      const images: Array<{type:"image";data:string;mimeType:string}> = [];
      for (const a of attachments ?? []) if (a.type === "image") { const path = resolveAttachmentPath({ attachmentsDir: cfg.attachmentsDir, attachment: a }); if (!path || !contained(cfg.attachmentsDir, path)) throw Error("Invalid attachment path"); const real = await realpath(path); const st = await stat(real); if (!st.isFile() || !contained(cfg.attachmentsDir, real) || st.size > MAX_IMAGE || !/^image\//i.test(a.mimeType)) throw Error("Invalid image attachment"); images.push({ type: "image", data: (await NodeFSP.readFile(real)).toString("base64"), mimeType: a.mimeType }); }
      const response = await client!.command({ type: "prompt", message: prompt, ...(images.length ? { images } : {}) }, { signal: controller!.signal }); if (!response.success) throw Error("Prime prompt failed");
      let events = 0; let updateSnapshot = ""; const iterator = client!.events(); for (;;) { const result = await Promise.race([iterator.next(), deadline]); if (result.done) break; const envelope = result.value; if (++events > MAX_EVENTS) throw Error("Prime emitted too many events"); if (envelope._tag === "malformed" || envelope._tag === "unknown-event" || envelope._tag === "command" || envelope._tag === "response") throw Error("Prime emitted malformed or unexpected event"); const event = envelope.value as { type: string; message?: unknown; assistantMessageEvent?: unknown }; if (event.type === "message_update") { const values: string[] = []; appendText(event.assistantMessageEvent ?? event.message, values); const delta = values.join(""); updateSnapshot += delta; } else if (event.type === "message_end") { const values: string[] = []; appendText(event.message, values); const text = values.join(""); if (text) { if (text.startsWith(updateSnapshot)) chunks.push(updateSnapshot, text.slice(updateSnapshot.length)); else chunks.push(text); } else if (updateSnapshot) chunks.push(updateSnapshot); updateSnapshot = ""; } else if (event.type === "turn_end") { if (updateSnapshot) chunks.push(updateSnapshot); ended = true; break; } }
      const output = chunks.join(""); if (!ended || output.length === 0 || output.length > MAX_OUTPUT) throw Error("Prime returned incomplete or oversized output");
      const match = output.match(/\{[\s\S]*\}/); if (!match) throw Error("Prime returned malformed structured output"); const parsed: unknown = JSON.parse(match[0]); const decoded = Schema.decodeUnknownSync(outputSchema)(parsed); return convert(decoded as Record<string, unknown>);
    } catch (cause) { if (cause instanceof TextGenerationError) throw cause; throw fail(operation, "Prime Agent text-generation request failed.", cause); }
    finally { await finalize(); }
  };
  const runPrompt = <T>(op: Op, cwd: string, selection: ModelSelection, built: {prompt:string; outputSchema: Schema.Codec<any, any, never>}, convert: (x: Record<string, unknown>) => T, attachments?: ReadonlyArray<ChatAttachment>) => Effect.tryPromise({ try: () => run(op,cwd,built.prompt,selection,built.outputSchema,convert,attachments), catch: (e) => e instanceof TextGenerationError ? e : fail(op,"Prime Agent text generation failed.",e) });
  return { generateCommitMessage: (i: TextGeneration.CommitMessageGenerationInput) => { const b=buildCommitMessagePrompt(i); return runPrompt("generateCommitMessage",i.cwd,i.modelSelection,b,x=>({subject:sanitizeCommitSubject(x.subject as string),body:x.body as string,...(i.includeBranch ? {branch:sanitizeFeatureBranchName(x.branch as string)} : {})})); }, generatePrContent: (i: TextGeneration.PrContentGenerationInput) => { const b=buildPrContentPrompt(i); return runPrompt("generatePrContent",i.cwd,i.modelSelection,b,x=>({title:sanitizePrTitle(x.title as string),body:x.body as string})); }, generateBranchName: (i: TextGeneration.BranchNameGenerationInput) => { const b=buildBranchNamePrompt(i); return runPrompt("generateBranchName",i.cwd,i.modelSelection,b,x=>({branch:sanitizeFeatureBranchName(sanitizeBranchFragment(x.branch as string))}),i.attachments); }, generateThreadTitle: (i: TextGeneration.ThreadTitleGenerationInput) => { const b=buildThreadTitlePrompt(i); return runPrompt("generateThreadTitle",i.cwd,i.modelSelection,b,x=>({title:sanitizeThreadTitle(x.title as string)}),i.attachments); } } satisfies TextGeneration.TextGeneration["Service"];
});

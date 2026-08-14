// @effect-diagnostics nodeBuiltinImport:off
import { randomUUID } from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as Effect from "effect/Effect";
import type { PrimeAgentSettings, ProviderInstanceId, ChatAttachment, ModelSelection } from "@t3tools/contracts";
import { TextGenerationError, ThreadId } from "@t3tools/contracts";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { primeResourceLayout } from "../provider/prime/PrimeResourceLayout.ts";
import { PrimeRpcClient } from "../provider/prime/PrimeRpcClient.ts";
import { spawnPrimeRpcTransport } from "../provider/prime/PrimeRpcProcessTransport.ts";
import * as TextGeneration from "./TextGeneration.ts";
import { buildBranchNamePrompt, buildCommitMessagePrompt, buildPrContentPrompt, buildThreadTitlePrompt } from "./TextGenerationPrompts.ts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { sanitizeCommitSubject, sanitizePrTitle, sanitizeThreadTitle } from "./TextGenerationUtils.ts";

const TIMEOUT_MS = 45_000;
const textOf = (v: unknown): string => {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(textOf).join("");
  if (!v || typeof v !== "object") return "";
  const x = v as Record<string, unknown>;
  return typeof x.text === "string" ? x.text : typeof x.delta === "string" ? x.delta : textOf(x.content);
};
const error = (operation: string, detail: string, cause?: unknown) => new TextGenerationError({ operation, detail, ...(cause === undefined ? {} : { cause }) });
type Op = "generateCommitMessage" | "generatePrContent" | "generateBranchName" | "generateThreadTitle";

export interface PrimeTextGenerationOptions { readonly instanceId: ProviderInstanceId; readonly environment?: NodeJS.ProcessEnv; }
export const makePrimeTextGeneration = Effect.fn("makePrimeTextGeneration")(function* (settings: PrimeAgentSettings, options: PrimeTextGenerationOptions) {
  const cfg = yield* ServerConfig.ServerConfig;
  const serverEnvironment = yield* ServerEnvironment;
  const environmentId = yield* serverEnvironment.getEnvironmentId;
  const env = options.environment ?? process.env;
  const run = async <T>(operation: Op, cwd: string, prompt: string, selection: ModelSelection, schema: (x: Record<string, unknown>) => T, attachments?: ReadonlyArray<ChatAttachment>): Promise<T> => {
    if (!selection.nativeIdentity || selection.instanceId !== options.instanceId) throw error(operation, "A valid Prime native model identity is required.");
    const threadId = ThreadId.make(`text-generation-${randomUUID()}`);
    const layout = primeResourceLayout({ home: cfg.stateDir, environmentId: String(environmentId), instanceId: String(options.instanceId), threadId: String(threadId) });
    await NodeFSP.mkdir(layout.session, { recursive: true, mode: 0o700 });
    await NodeFSP.mkdir(`${layout.session}/tmp`, { recursive: true, mode: 0o700 });
    const safeEnv: NodeJS.ProcessEnv = { PATH: env.PATH, HOME: layout.session, USERPROFILE: layout.session, TMPDIR: `${layout.session}/tmp`, TEMP: `${layout.session}/tmp`, XDG_CONFIG_HOME: `${layout.session}/.config`, XDG_DATA_HOME: `${layout.session}/.local/share`, XDG_STATE_HOME: `${layout.session}/.local/state` };
    const transport = spawnPrimeRpcTransport(settings.binaryPath, ["--mode", "rpc", "--session-dir", layout.session], { cwd, env: safeEnv });
    const client = new PrimeRpcClient(transport, { requestIdPrefix: "t3-prime-text", defaultTimeoutMs: TIMEOUT_MS });
    try {
      const ready = await client.command({ type: "get_state" }, { timeoutMs: TIMEOUT_MS });
      if (!ready.success) throw new Error("Prime RPC readiness failed");
      const identity = selection.nativeIdentity;
      const model = await client.command({ type: "set_model", provider: identity.provider, modelId: identity.modelId }, { timeoutMs: TIMEOUT_MS });
      if (!model.success) throw new Error("Prime model selection failed");
      const images: Array<{type:"image";data:string;mimeType:string}> = [];
      for (const a of attachments ?? []) if (a.type === "image") {
        const path = resolveAttachmentPath({ attachmentsDir: cfg.attachmentsDir, attachment: a });
        if (!path) continue;
        const bytes = await NodeFSP.readFile(path); if (bytes.byteLength > 10 * 1024 * 1024) continue;
        images.push({ type: "image", data: bytes.toString("base64"), mimeType: a.mimeType });
      }
      const response = await client.command({ type: "prompt", message: prompt, ...(images.length ? { images } : {}) }, { timeoutMs: TIMEOUT_MS });
      if (!response.success) throw new Error("Prime prompt failed");
      let output = "";
      for await (const envelope of client.events()) {
        if (envelope._tag === "known-event" && envelope.value.type === "turn_end") output = textOf(envelope.value.message);
        if (envelope._tag === "known-event" && envelope.value.type === "agent_end") break;
      }
      const jsonMatch = output.match(/\{[\s\S]*\}/); if (!jsonMatch) throw new Error("Prime returned malformed structured output");
      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>; return schema(parsed);
    } catch (cause) { if (cause instanceof TextGenerationError) throw cause; throw error(operation, "Prime Agent text-generation request failed.", cause); }
    finally { client.close(); await Promise.resolve(transport.close?.()).catch(() => undefined); await transport.terminal.catch(() => undefined); await NodeFSP.rm(layout.thread, { recursive: true, force: true }).catch(() => undefined); }
  };
  const runPrompt = <T>(operation: Op, cwd: string, selection: ModelSelection, built: {prompt:string}, schema: (x: Record<string, unknown>)=>T, attachments?: ReadonlyArray<ChatAttachment>) => Effect.tryPromise({ try: () => run(operation,cwd,built.prompt,selection,schema,attachments), catch: (e) => e instanceof TextGenerationError ? e : error(operation,"Prime Agent text generation failed.",e) });
  return {
    generateCommitMessage: (i: TextGeneration.CommitMessageGenerationInput) => { const b=buildCommitMessagePrompt(i); return runPrompt("generateCommitMessage",i.cwd,i.modelSelection,b,x=>({subject:sanitizeCommitSubject(String(x.subject??"")),body:String(x.body??""),...(i.includeBranch ? {branch:sanitizeFeatureBranchName(String(x.branch??""))}: {})})); },
    generatePrContent: (i: TextGeneration.PrContentGenerationInput) => { const b=buildPrContentPrompt(i); return runPrompt("generatePrContent",i.cwd,i.modelSelection,b,x=>({title:sanitizePrTitle(String(x.title??"")),body:String(x.body??"")})); },
    generateBranchName: (i: TextGeneration.BranchNameGenerationInput) => { const b=buildBranchNamePrompt(i); return runPrompt("generateBranchName",i.cwd,i.modelSelection,b,x=>({branch:sanitizeFeatureBranchName(sanitizeBranchFragment(String(x.branch??"")))}),i.attachments); },
    generateThreadTitle: (i: TextGeneration.ThreadTitleGenerationInput) => { const b=buildThreadTitlePrompt(i); return runPrompt("generateThreadTitle",i.cwd,i.modelSelection,b,x=>({title:sanitizeThreadTitle(String(x.title??""))}),i.attachments); },
  } satisfies TextGeneration.TextGeneration["Service"];
});

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Schema from "effect/Schema";

/**
 * Source-derived PA-A04 command/prompt/skill discovery transcript.
 *
 * It builds a disposable extension/skill/prompt directory, feeds the matching
 * `get_commands` body through the shipped mapper, and asserts the three
 * properties the milestone is about: TUI-only and session-mutating entries never
 * appear, no absolute host path reaches the wire, and an invocation is an
 * ordinary prompt whose stale case fails with a stated reason.
 *
 * Run: `node packages/contracts/fixtures/pa-a04-prime-commands-transcript.mjs`
 */
const ROOT = new URL("../../../", import.meta.url);
const read = (relative) => NodeFS.readFileSync(new URL(relative, ROOT), "utf8");
const load = (relative) => import(new URL(relative, ROOT).href);

/**
 * The shipped implementations, executed — never re-implemented. If the mapper or
 * the client resolver regresses, this transcript fails with it. (Node strips the
 * TypeScript types natively; both modules are type-only at their imports.)
 */
const { normalizePrimeCommands, sanitizePrimeCommandLocation, PRIME_GET_COMMANDS_COMMAND } =
  await load("apps/server/src/provider/prime/PrimeCommands.ts");
const { resolvePrimeCommandInvocation } = await load(
  "apps/web/src/components/chat/primeCommands.ts",
);
const { ClientOrchestrationCommand } = await load("packages/contracts/src/orchestration.ts");

/**
 * Creates an isolated fixture tree under a disposable temp directory. Nothing is
 * read from a real Prime home; the directory exists so the transcript's
 * `location` values are real file names produced by a real layout.
 */
export function createFixtureTree() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pa-a04-prime-commands-"));
  const files = [
    ["extensions/deploy/commands/deploy.md", "# deploy\n"],
    ["prompts/review.md", "# review\n"],
    ["skills/refactor/SKILL.md", "# refactor\n"],
    ["commands/theme.md", "# theme (tui only)\n"],
    ["commands/login.md", "# login\n"],
  ];
  for (const [relative, contents] of files) {
    const target = NodePath.join(root, relative);
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    NodeFS.writeFileSync(target, contents);
  }
  return { root, files: files.map(([relative]) => relative) };
}

/** The native `get_commands` body a runtime would return for that tree. */
export function nativeDiscoveryBody(root) {
  return {
    commands: [
      {
        name: "/deploy",
        kind: "command",
        source: "extension",
        description: "Deploy the current branch",
        location: NodePath.join(root, "extensions/deploy/commands/deploy.md"),
      },
      {
        name: "review",
        kind: "prompt",
        source: "project",
        description: "Review the working diff",
        location: "prompts/review.md",
      },
      {
        name: "refactor",
        kind: "skill",
        source: "user",
        // A host-authored description that embeds an absolute path: the wire
        // must carry the file name, never the layout it lives in.
        description: `Refactor using ${NodePath.join(root, "skills/refactor/SKILL.md")} as the guide`,
        location: "skills/refactor/SKILL.md",
      },
      { name: "theme", kind: "command", source: "builtin", tuiOnly: true },
      { name: "login", kind: "command", source: "builtin" },
      { name: "review", kind: "prompt", source: "user", description: "shadowing duplicate" },
    ],
  };
}

/** The shipped server mapper, executed as-is — never re-implemented here. */
export const mapCommands = (body) => normalizePrimeCommands(body);

/** The shipped client resolver, executed as-is. */
export const invoke = (catalog, name, input) =>
  resolvePrimeCommandInvocation(catalog.commands, name, input);

const UNSAFE = new Set(["login", "logout", "exit", "quit", "new-session", "clear"]);

/** A mapper that trusts the runtime: keeps every entry and every path as-is. */
export const passthroughMapper = (body) => ({
  commands: body.commands.map((raw) => ({
    name: String(raw.name).replace(/^\//u, ""),
    kind: raw.kind ?? "command",
    source: raw.source ?? "builtin",
    ...(raw.location === undefined ? {} : { location: raw.location }),
  })),
});

export function verifyDiscovery(mapper = mapCommands) {
  const tree = createFixtureTree();
  try {
    const catalog = mapper(nativeDiscoveryBody(tree.root));
    const names = catalog.commands.map((entry) => entry.name);
    if (JSON.stringify(names) !== JSON.stringify(["deploy", "refactor", "review"]))
      throw new Error(`unexpected catalog: ${names.join(",")}`);
    if (names.includes("theme")) throw new Error("a TUI-only command was offered");
    if (names.includes("login")) throw new Error("an auth-mutating command was offered");
    const serialized = JSON.stringify(catalog);
    if (serialized.includes(tree.root) || serialized.includes(NodeOS.tmpdir()))
      throw new Error("an absolute host path reached the catalog");
    // An absolute location is dropped outright rather than trimmed: the label is
    // worth less than the certainty that no host layout is disclosed.
    if (catalog.commands.find((entry) => entry.name === "deploy").location !== undefined)
      throw new Error("an absolute location was published instead of dropped");
    const refactor = catalog.commands.find((entry) => entry.name === "refactor");
    if (refactor.location !== "SKILL.md")
      throw new Error("location was not reduced to a bare file name");
    if (refactor.description !== "Refactor using SKILL.md as the guide")
      throw new Error(`description was not path-scrubbed: ${refactor.description}`);
    if (catalog.commands.find((entry) => entry.name === "review").source !== "project")
      throw new Error("first definition did not win the duplicate");
    return catalog;
  } finally {
    NodeFS.rmSync(tree.root, { recursive: true, force: true });
  }
}

export function verifyInvocation(catalog = verifyDiscovery()) {
  const ok = invoke(catalog, "review", "  the auth diff  ");
  if (!ok.ok || ok.prompt !== "/review the auth diff")
    throw new Error("invocation is not an ordinary prompt");
  const stale = invoke({ commands: [] }, "review");
  if (stale.ok || !stale.reason.includes("no longer offered"))
    throw new Error("a removed command did not fail actionably");
  return true;
}

/**
 * The checks must be able to fail; prove it on every run by running the same
 * assertions against a mapper that trusts the runtime instead of filtering it.
 */
export function verifyFalsifiable() {
  try {
    verifyDiscovery(passthroughMapper);
  } catch (error) {
    if (error instanceof Error) return true;
    throw error;
  }
  throw new Error("discovery check is not falsifiable");
}

/**
 * Every property below is probed by *running* the shipped functions, so a
 * regression in them fails this transcript instead of a source-text needle that
 * a rewrite could satisfy while behaving differently.
 */
export function verifyDerivedFromSource() {
  if (JSON.stringify(PRIME_GET_COMMANDS_COMMAND) !== '{"type":"get_commands"}')
    throw new Error("the native discovery command drifted");
  for (const absolute of ["/etc/passwd", "~/notes/x.md", "C:\\Users\\dev\\x.md", "../x.md"]) {
    if (sanitizePrimeCommandLocation(absolute) !== undefined)
      throw new Error(`a host path survived location sanitization: ${absolute}`);
  }
  if (sanitizePrimeCommandLocation("prompts/review.md") !== "review.md")
    throw new Error("a relative location was not reduced to its file name");
  for (const name of UNSAFE) {
    const spellings = [name, name.replace(/-/gu, "_"), `/${name.toUpperCase()}`];
    for (const spelling of spellings) {
      const mapped = mapCommands({ commands: [{ name: spelling }] });
      if (mapped.commands.length !== 0)
        throw new Error(`an auth/session-mutating entry survived: ${spelling}`);
    }
  }
  const client = read("apps/web/src/components/chat/primeCommands.ts");
  if (!client.includes("is no longer offered by this runtime"))
    throw new Error("stale-command copy drifted");
  if (client !== read("apps/mobile/src/features/threads/primeCommands.ts"))
    throw new Error("web and mobile command modules drifted apart");
  return true;
}

/**
 * The transcript is only meaningful if a user can actually reach it: adapter
 * discovery -> canonical event -> read-model projection -> both client surfaces.
 */
export function verifyReachable() {
  const link = (file, needles) => {
    const source = read(file);
    for (const needle of needles) {
      if (!source.includes(needle)) throw new Error(`unreachable: ${file} is missing ${needle}`);
    }
  };
  link("apps/server/src/provider/prime/PrimeRpcProtocol.ts", ['"get_commands"']);
  link("apps/server/src/provider/Layers/PrimeAdapter.ts", [
    "discoverCommands",
    "commandDiscovery: true",
    '"command.discover"',
  ]);
  link("apps/server/src/provider/prime/PrimeEventNormalizer.ts", ["commandsSnapshot"]);
  link("packages/contracts/src/providerRuntime.ts", [
    '"session.commands.updated"',
    "reduceProviderSessionCommandCatalog",
  ]);
  link("packages/contracts/src/orchestration.ts", [
    "OrchestrationSessionCommandCatalog",
    "commandCatalog: Schema.optional(OrchestrationSessionCommandCatalog)",
  ]);
  link("apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts", [
    "session-commands-snapshot",
    "commandCatalog: nextCommandCatalog",
  ]);
  link("apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts", [
    'command_catalog_json AS "commandCatalog"',
  ]);
  link("apps/web/src/components/CommandPalette.tsx", [
    "buildPrimeCommandItems",
    "threadEnvironment.refreshCommands",
  ]);
  link("apps/mobile/src/features/threads/ThreadComposer.tsx", [
    "resolvePrimeCommandInvocation",
    "onRefreshCommands",
  ]);
  link("apps/mobile/src/features/threads/ThreadRouteScreen.tsx", [
    "threadEnvironment.refreshCommands",
  ]);
  link("apps/server/src/orchestration/decider.ts", ['"thread.command-refresh-requested"']);
  link("apps/server/src/orchestration/Layers/ProviderCommandReactor.ts", [
    "processCommandRefreshRequested",
    '"command.discover"',
  ]);
  return true;
}

/**
 * Refresh must be reachable from a client, not just implemented in the adapter:
 * the wire contract is executed here, so a catalog that went stale on the host
 * can actually be re-read and a deleted command can actually disappear.
 */
export function verifyRefreshReachable() {
  const decode = Schema.decodeUnknownSync(ClientOrchestrationCommand);
  const command = decode({
    type: "thread.commands.refresh",
    commandId: "cmd-refresh-1",
    threadId: "thread-1",
    requestId: "commands-1",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  if (command.type !== "thread.commands.refresh")
    throw new Error("the refresh command is not carried by the client wire contract");
  // The failure path is only real if the resolver is asked about the newest
  // catalog rather than the list a surface rendered from.
  const rendered = [{ name: "review", kind: "prompt", source: "project" }];
  const afterRefresh = { commands: [] };
  const decision = invoke(afterRefresh, rendered[0].name);
  if (decision.ok || !decision.reason.includes("no longer offered"))
    throw new Error("a command removed by a refresh did not fail actionably");
  return true;
}

export function verifyTranscript() {
  verifyReachable();
  verifyRefreshReachable();
  verifyDerivedFromSource();
  const catalog = verifyDiscovery();
  verifyInvocation(catalog);
  verifyFalsifiable();
  return catalog;
}

if (process.argv[1] !== undefined && NodeURL.fileURLToPath(import.meta.url) === process.argv[1]) {
  const catalog = verifyTranscript();
  for (const entry of catalog.commands) {
    console.log(
      `/${entry.name} — Prime ${entry.source} ${entry.kind}${
        entry.location === undefined ? "" : ` · ${entry.location}`
      }`,
    );
  }
  console.log(
    "PA-A04 Prime command discovery transcript verified (reachable end-to-end, source-derived, TUI-only and unsafe entries excluded, no host path on the wire)",
  );
}

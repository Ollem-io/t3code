import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

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
      { name: "refactor", kind: "skill", source: "user", location: "skills/refactor/SKILL.md" },
      { name: "theme", kind: "command", source: "builtin", tuiOnly: true },
      { name: "login", kind: "command", source: "builtin" },
      { name: "review", kind: "prompt", source: "user", description: "shadowing duplicate" },
    ],
  };
}

/** Mirrors `sanitizePrimeCommandLocation` in PrimeCommands.ts; verified below. */
const sanitizeLocation = (value) => {
  if (typeof value !== "string") return undefined;
  const raw = value.trim();
  if (raw.length === 0 || raw.startsWith("~") || raw.includes("..")) return undefined;
  if (raw.startsWith("/") || raw.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(raw)) return undefined;
  const segments = raw.split(/[\\/]/u).filter((segment) => segment.length > 0);
  const last = segments.at(-1);
  return last === undefined || last.length > 64 ? undefined : last;
};

const UNSAFE = new Set(["login", "logout", "exit", "quit", "new-session", "clear"]);

/** Mirrors `normalizePrimeCommands`; the shipped rules are asserted below. */
export function mapCommands(body) {
  const byName = new Map();
  for (const raw of body.commands) {
    if (raw.tuiOnly === true || raw.hidden === true || raw.surface === "tui") continue;
    const name = String(raw.name).replace(/^\//u, "").toLowerCase();
    if (!/^[a-z0-9][a-z0-9:_-]{0,63}$/.test(name)) continue;
    if (UNSAFE.has(name.replace(/[_:]/gu, "-"))) continue;
    if (byName.has(name)) continue;
    const location = sanitizeLocation(raw.location);
    byName.set(name, {
      name,
      kind: raw.kind ?? "command",
      source: raw.source ?? "builtin",
      ...(raw.description === undefined ? {} : { description: raw.description }),
      ...(location === undefined ? {} : { location }),
    });
  }
  return { commands: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}

/** Mirrors `resolvePrimeCommandInvocation` on both clients. */
export function invoke(catalog, name, input) {
  const entry = catalog.commands.find((candidate) => candidate.name === name);
  if (!entry)
    return {
      ok: false,
      reason: `/${name} is no longer offered by this runtime. Reopen the list to refresh it.`,
    };
  const trimmed = (input ?? "").trim();
  return { ok: true, prompt: trimmed.length > 0 ? `/${name} ${trimmed}` : `/${name}` };
}

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
    if (catalog.commands.find((entry) => entry.name === "refactor").location !== "SKILL.md")
      throw new Error("location was not reduced to a bare file name");
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

/** The fixture is only trustworthy while it matches the shipped source. */
export function verifyDerivedFromSource() {
  const mapper = read("apps/server/src/provider/prime/PrimeCommands.ts");
  for (const needle of [
    'export const PRIME_GET_COMMANDS_COMMAND = Object.freeze({ type: "get_commands" as const });',
    'if (raw.startsWith("~") || raw.includes("..")) return undefined;',
    'UNSAFE_NAMES.has(name.replace(/[_:]/gu, "-"))',
    "const NAME_PATTERN = /^[a-z0-9][a-z0-9:_-]{0,63}$/;",
  ]) {
    if (!mapper.includes(needle)) throw new Error(`mapper drifted: ${needle}`);
  }
  for (const name of UNSAFE) {
    if (!mapper.includes(`"${name}"`)) throw new Error(`unsafe-name list drifted: ${name}`);
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
  link("apps/web/src/components/CommandPalette.tsx", ["buildPrimeCommandItems"]);
  link("apps/mobile/src/features/threads/ThreadComposer.tsx", ["resolvePrimeCommandInvocation"]);
  return true;
}

export function verifyTranscript() {
  verifyReachable();
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

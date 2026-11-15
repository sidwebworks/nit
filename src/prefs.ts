import { z } from "zod";
import { childEnv } from "./child-env";
import { compiled } from "./embedded";
import type { Store } from "./store";
import { DEFAULT_PREFS, type Prefs } from "./types";

const FIELDS = {
  fontSize: z.number().min(10).max(18),
  wrap: z.boolean(),
  indicators: z.enum(["bars", "classic", "none"]),
  inlineChanges: z.enum(["word", "char", "none"]),
  model: z.enum(["default", "opus", "sonnet", "haiku"]),
  effort: z.enum(["default", "low", "medium", "high", "xhigh", "max"]),
  nits: z.boolean(),
  auth: z.enum(["login", "apiKey"]),
  hideGenerated: z.boolean(),
  hideTests: z.boolean(),
  hideDocs: z.boolean(),
  hideViewed: z.boolean(),
  hideWhitespace: z.boolean(),
  guided: z.boolean(),
  reviewer: z.enum(["claude", "codex"]),
  codexAuth: z.enum(["login", "apiKey"]),
  codexModel: z.string().trim().max(64),
  codexEffort: z.enum(["default", "low", "medium", "high", "xhigh"]),
} satisfies Record<keyof Prefs, z.ZodType>;

/** What the settings screen may save. Keys nit doesn't know (an older or newer page's) are dropped. */
export const PrefsPatch = z.object(FIELDS).partial();

/**
 * Saved preferences over the defaults, field by field: one that's missing, renamed in a later
 * version or out of range falls back to its default without taking the others with it.
 */
export function prefsOf(store: Store): Prefs {
  const saved = (store.setting("prefs") ?? {}) as Record<string, unknown>;
  const prefs: Record<string, unknown> = { ...DEFAULT_PREFS };
  for (const [key, schema] of Object.entries(FIELDS)) {
    const v = schema.safeParse(saved[key]);
    if (v.success) prefs[key] = v.data;
  }
  return prefs as Prefs;
}

const KEY = { service: "nit", name: "anthropic-api-key" };
let key: Promise<string | null> | undefined;

/** The API key saved in nit, from your OS keychain (read once). */
export const savedKey = () => {
  key ??= Bun.secrets.get(KEY).catch(() => null);
  return key;
};

/** Saves (or, with null, removes) nit's API key in your OS keychain. */
export async function saveKey(value: string | null) {
  if (value) await Bun.secrets.set({ ...KEY, value });
  else await Bun.secrets.delete(KEY);
  key = Promise.resolve(value);
}

/**
 * Claude Code's environment: the basics it needs (child-env.ts), no Claude settings or credentials from
 * nit's environment, so it uses its own login; with "API key" chosen, the key saved in nit.
 */
export async function claudeEnv(p: Pick<Prefs, "auth">): Promise<Record<string, string | undefined>> {
  const env: Record<string, string | undefined> = { ...childEnv(), CLAUDE_AGENT_SDK_CLIENT_APP: "nit" };
  const saved = p.auth === "apiKey" ? await savedKey() : null;
  if (saved) env.ANTHROPIC_API_KEY = saved;
  return env;
}

/** The SDK options the preferences set: only what isn't Claude Code's default. */
/**
 * The single binary doesn't carry Claude Code (it's 300 MB): it runs the one you installed.
 * Run from source, the Agent SDK brings its own.
 */
function claudeExecutable() {
  if (!compiled()) return {};
  const bin = Bun.which("claude");
  if (!bin)
    throw new Error("nit needs Claude Code for this. Install it (https://claude.com/claude-code) and try again.");
  return { pathToClaudeCodeExecutable: bin };
}

export async function claudeOptions(p: Prefs, kind: "ask" | "review" | "guide" | "apply" = "review") {
  return {
    ...claudeExecutable(),
    env: await claudeEnv(p),
    // Only nit's own tools. Your account's claude.ai connectors and MCP servers added ~400K tokens
    // of tool definitions to every turn after the first tool call, and your auto-memory notes
    // (about other work) reached the review: both slow every answer and neither belongs here.
    strictMcpConfig: true,
    settings: { disableClaudeAiConnectors: true, autoMemoryEnabled: false },
    ...(p.model !== "default" ? { model: p.model } : {}),
    // Questions are a conversation you wait on: low effort answers about twice as fast with the same
    // grounding (measured on PR 2212). Co-review and apply keep Claude Code's default depth.
    ...(p.effort !== "default"
      ? { effort: p.effort }
      : kind === "ask" || kind === "guide"
        ? { effort: "low" as const }
        : {}),
  };
}

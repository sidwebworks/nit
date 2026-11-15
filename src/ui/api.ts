import type {
  AgentRun,
  AskThread,
  AuthStatus,
  CommandSettings,
  Draft,
  FileContents,
  GitHubAccount,
  GitHubState,
  Job,
  LinearLink,
  Location,
  PostResult,
  Prefs,
  ReviewData,
  ReviewEvent,
  SearchResult,
  Side,
  Symbol as Sym,
} from "../types";

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: method === "GET" ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

const q = (params: Record<string, string | number | undefined>) =>
  new URLSearchParams(
    Object.entries(params)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, String(v)]),
  );

export type At = { path: string; side: Side; line: number };

export const api = {
  agent: () => call<{ run: AgentRun | null }>("GET", "/api/agent"),
  applyAgent: (ids?: string[]) => call<{ run: AgentRun }>("POST", "/api/agent/apply", { ids }),
  coreview: () => call<{ job: Job }>("POST", "/api/coreview", {}),
  guide: () => call<{ job: Job }>("POST", "/api/guide", {}),
  ask: (b: { path: string; side: Side; start: number; end: number; question: string; followUp?: string | null }) =>
    call<{ job: Job }>("POST", "/api/ask", b),
  job: () => call<{ job: Job | null }>("GET", "/api/agent/job"),
  asks: () => call<AskThread[]>("GET", "/api/asks"),
  deleteAsk: (id: string) => call<{ ok: true }>("DELETE", `/api/asks/${encodeURIComponent(id)}`),
  auth: () => call<AuthStatus>("GET", "/api/auth"),
  codexAuth: () => call<AuthStatus>("GET", "/api/auth/codex"),
  saveCodexKey: (key: string | null) => call<{ hasKey: boolean }>("PUT", "/api/settings/codex-key", { key }),
  stopAgent: () => call<{ ok: true }>("POST", "/api/agent/stop", {}),
  undoAgent: () => call<{ restored: string[]; kept: string[] }>("POST", "/api/agent/undo", {}),
  agentChanges: async () => {
    const res = await fetch("/api/agent/changes");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  },
  search: (query: string, regex: boolean, caseSensitive: boolean, after?: string) =>
    call<SearchResult>(
      "GET",
      `/api/search?${q({ q: query, regex: regex ? 1 : undefined, case: caseSensitive ? 1 : undefined, after })}`,
    ),
  saveTheme: (theme: unknown) => call<{ ok: true }>("PUT", "/api/settings", { theme }),
  saveLayout: (layout: unknown) => call<{ ok: true }>("PUT", "/api/settings", { layout }),
  savePrefs: (prefs: Partial<Prefs>) => call<Prefs>("PUT", "/api/settings/prefs", prefs),
  saveClaudeKey: (key: string | null) => call<{ hasKey: boolean }>("PUT", "/api/settings/claude-key", { key }),
  githubAccount: () => call<GitHubAccount | null>("GET", "/api/settings/github"),
  saveGitHubToken: (token: string | null) => call<GitHubAccount>("PUT", "/api/settings/github", { token }),
  commands: () => call<CommandSettings>("GET", "/api/settings/commands"),
  saveCommands: (patch: Partial<Record<"checkout" | "editor", string | null>>) =>
    call<CommandSettings>("PUT", "/api/settings/commands", patch),
  openInEditor: (path: string, line: number) => call<{ ran: string }>("POST", "/api/open-in-editor", { path, line }),
  linear: () => call<LinearLink | null>("GET", "/api/linear"),
  linearKey: () => call<{ hasKey: boolean }>("GET", "/api/settings/linear-key"),
  saveLinearKey: (key: string | null) => call<{ hasKey: boolean }>("PUT", "/api/settings/linear-key", { key }),
  review: (ignoreSpace: boolean) => call<ReviewData>("GET", `/api/review${ignoreSpace ? "?w" : ""}`),
  file: (path: string, prev?: string) =>
    call<FileContents>("GET", `/api/file?${new URLSearchParams({ path, prev: prev ?? "" })}`),
  saveDraft: (d: Draft) => call<Draft>("PUT", "/api/drafts", d),
  deleteDraft: (id: string) => call("DELETE", `/api/drafts/${id}`, {}),
  applySuggestion: (id: string) => call("POST", `/api/drafts/${id}/apply`, {}),
  setViewed: (path: string, viewed: boolean) => call("POST", "/api/viewed", { path, viewed }),
  viewedText: (path: string) => call<{ text: string | null }>("GET", `/api/viewed-text?${q({ path })}`),

  github: (fresh = false) => call<GitHubState>("GET", `/api/github${fresh ? "?fresh=1" : ""}`),
  postReview: (event: ReviewEvent, summary: string) =>
    call<PostResult>("POST", "/api/github/review", { event, summary }),
  resolveThread: (id: string, resolved: boolean) => call("POST", `/api/github/threads/${id}/resolve`, { resolved }),

  symbols: (path: string, prev?: string, includeOld = true) =>
    call<{ new: Sym[] | null; old: Sym[] | null }>(
      "GET",
      `/api/symbols?${q({ path, prev, old: includeOld ? undefined : 0 })}`,
    ),
  identifiers: (at: At) => call<{ name: string; col: number }[]>("GET", `/api/identifiers?${q(at)}`),
  definition: (at: At, by: { name: string } | { col: number }) =>
    call<{ name: string | null; results: Location[] }>("GET", `/api/definition?${q({ ...at, ...by })}`),
  references: (name: string) =>
    call<{ name: string; changed: Location[]; untouched: Location[]; text: Location[]; truncated: boolean }>(
      "GET",
      `/api/references?${q({ name })}`,
    ),
};

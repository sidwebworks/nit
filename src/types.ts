export type Side = "additions" | "deletions";

/** Why Claude proposed a comment: what it checked, and the rule it relies on. */
export type Proposal = {
  /** CONFIRMED: Claude read the evidence. PLAUSIBLE: one unverified assumption (asked as a question). */
  verdict: "CONFIRMED" | "PLAUSIBLE";
  severity: "important" | "nit";
  /** The input or state that makes it fail. */
  trigger: string | null;
  /** file:line locations Claude read to support it. */
  evidence: string[];
  /** The project guideline it cites, quoted from the base branch. */
  guideline: { file: string; quote: string } | null;
};

export type Draft = {
  id: string;
  path: string;
  side: Side;
  start: number;
  end: number;
  body: string;
  /** Replacement text for lines start..end on the additions side, or null. */
  suggestion: string | null;
  /** The commented lines' text when the draft was written, used to re-anchor it later. */
  anchor: string[];
  /** A reply to an existing GitHub review thread (its id), posted with the review. */
  replyTo?: string | null;
  /** Set while this is Claude's proposal: never posted or applied until the reviewer accepts it. */
  proposal?: Proposal | null;
  createdAt: number;
  updatedAt: number;
};

export type ReviewData = {
  repo: string;
  branch: string;
  base: string;
  mergeBase: string;
  patch: string;
  drafts: Draft[];
  /** Changed files that aren't the change itself: generated, tests, docs (others are code). */
  categories: Record<string, FileCategory>;
  /** Files marked viewed whose diff hasn't changed since. */
  viewed: string[];
  /** Files marked viewed whose diff has changed since: to look at again. */
  changedSinceViewed: string[];
  asks: AskThread[];
  /** Claude's reading order for the files, if you asked for one. */
  guide: GuideChapter[] | null;
};

/** "formatting": only whitespace changed. */
/** A few files that belong together, in the order to read them. */
export type GuideChapter = { title: string; why: string; files: string[] };

export type FileCategory = "generated" | "test" | "docs" | "formatting";

/** A conversation with Claude about some lines, kept for the review so you can come back to it. */
export type AskThread = {
  id: string;
  path: string;
  side: Side;
  start: number;
  end: number;
  turns: { question: string; answer: string; at: number }[];
  /** Claude's session, so a follow-up continues the same conversation. */
  sessionId: string | null;
  updatedAt: number;
  /** The lines' text when asked, to follow them when the file changes. */
  anchor: string[];
  /** The lines are gone from the file: kept to read, but no longer placed or continued. */
  outdated?: boolean;
};

export type FileContents = { old: string | null; new: string | null };

/** A definition found by a grammar's tags query. Lines are 1-based. */
export type Symbol = {
  name: string;
  /** function, method, class, interface, module, type, constant… (from the query's capture name) */
  kind: string;
  line: number;
  startCol?: number;
  endLine: number;
  endCol?: number;
  nameLine: number;
  nameCol: number;
};

/** A place in the repo, for definitions and references. */
export type Location = {
  path: string;
  line: number;
  col: number;
  /** The line's text, trimmed. */
  text: string;
  /** The definition's code (up to ~15 lines), when this is a definition. */
  snippet?: string;
  snippetStart?: number;
  kind?: string;
  /** The file is part of this review's diff. */
  inDiff: boolean;
  /** The line itself was added or changed in this diff. */
  changed: boolean;
};

export type ThreadComment = {
  id: string;
  author: string;
  avatar: string | null;
  body: string;
  createdAt: string;
  url: string;
};

/** A review thread already on the pull request. `line` is null for file-level or outdated threads. */
export type Thread = {
  id: string;
  path: string;
  side: Side;
  line: number | null;
  startLine: number | null;
  subject: "line" | "file";
  resolved: boolean;
  outdated: boolean;
  comments: ThreadComment[];
};

export type PullRequest = { number: number; title: string; url: string; state: string; headSha: string };

/** A CI check on the PR's head commit, as GitHub's checks box shows it. */
export type Check = {
  name: string;
  state: "success" | "failure" | "pending" | "neutral";
  url: string | null;
  /** The status's description, or how the run ended. */
  summary: string | null;
};

/** A line a check flagged (a lint error, a failing test's line), on the PR's head commit. */
export type CheckAnnotation = {
  id: string;
  check: string;
  path: string;
  start: number;
  end: number;
  level: "failure" | "warning" | "notice";
  title: string | null;
  message: string;
};

export type LinearIssue = {
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  state: { name: string; color: string };
};

/** The Linear issue this branch is for: the issue itself once fetched with a saved API key. */
export type LinearLink = {
  key: string;
  url: string | null;
  issue: LinearIssue | null;
  hasKey: boolean;
  error?: string;
};

export type GitHubState =
  | { status: "unavailable"; reason: string }
  | {
      status: "ready";
      pr: PullRequest;
      viewer: string;
      threads: Thread[];
      /** The PR's description, as written (Markdown). */
      body: string;
      author: { login: string; avatar: string } | null;
      draft: boolean;
      openedAt: number;
      checks: Check[];
      annotations: CheckAnnotation[];
      /** Whether local lines match the PR: same commit and nothing uncommitted. */
      local: { headSha: string; dirty: boolean };
    };

export type ReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

export type PostResult = {
  url: string | null;
  posted: string[];
  /** Drafts posted as file comments because their lines aren't in the PR's diff. */
  asFileComments: string[];
  failed: { id: string; error: string }[];
};

/** One line matching a repo-wide search. Columns and ranges count UTF-16 units. */
export type SearchMatch = {
  path: string;
  line: number;
  text: string;
  ranges: [number, number][];
  /** Up to two lines either side, for the excerpt the match is shown in. */
  before: string[];
  after: string[];
};
export type SearchResult = {
  matches: SearchMatch[];
  /** More files are left to search; pass `next` back for the next page. */
  truncated: boolean;
  next: string | null;
  /** Set when a regex didn't compile and fff searched for the literal text instead. */
  regexError?: string;
};

/** What the agent did with one draft comment. */
export type AgentOutcome = { id: string; status: "done" | "skipped" | "question"; note: string };

/** One agent pass over the drafts, kept per review so results and undo outlive a restart. */
export type AgentRun = {
  id: string;
  drafts: string[];
  startedAt: number;
  endedAt: number | null;
  state: "running" | "done" | "stopped" | "failed" | "undone";
  /** Snapshot trees before and after (snapshot.ts). */
  before: string;
  after: string | null;
  files: { status: string; path: string }[];
  outcomes: AgentOutcome[];
  error: string | null;
  costUsd: number | null;
  /** The Agent SDK session, resumed by the next pass. */
  sessionId: string | null;
};

/** A read-only Claude job: a co-review of the diff, or a question about lines. */
/** Your preferences, shared by every review (nit's settings screen; kept in nit's database). */
export type Prefs = {
  /** Code size in the diff and files, px. */
  fontSize: number;
  /** Long lines wrap instead of scrolling sideways. */
  wrap: boolean;
  /** How changed lines are marked in the gutter. */
  indicators: "bars" | "classic" | "none";
  /** What changed inside a changed line is highlighted by word, by character, or not at all. */
  inlineChanges: "word" | "char" | "none";
  /** Claude's model for co-review, questions and apply; "default" is Claude Code's own choice. */
  model: "default" | "opus" | "sonnet" | "haiku";
  effort: "default" | "low" | "medium" | "high" | "xhigh" | "max";
  /** Co-review may propose nitpicks (at most two). */
  nits: boolean;
  /** How Claude signs in: Claude Code's own login, or the API key saved in nit (your keychain). */
  auth: "login" | "apiKey";
  /** Files set aside in the file list (and skipped by j/k); search and links still open them. */
  hideGenerated: boolean;
  hideTests: boolean;
  hideDocs: boolean;
  hideViewed: boolean;
  /** Diff ignoring whitespace (git diff -w); files where only whitespace changed are set aside. */
  hideWhitespace: boolean;
  /** List files in Claude's reading order (when there is one) instead of as a tree. */
  guided: boolean;
};

export const DEFAULT_PREFS: Prefs = {
  fontSize: 12.5,
  wrap: false,
  indicators: "bars",
  inlineChanges: "word",
  model: "default",
  effort: "default",
  nits: true,
  auth: "login",
  hideGenerated: true,
  hideTests: false,
  hideDocs: false,
  hideViewed: false,
  hideWhitespace: false,
  guided: true,
};

/** Your GitHub login for this repo's host: the token saved in nit, else the GitHub CLI's. */
export type GitHubAccount = { host: string; source: "nit" | "gh" | null; login: string | null; saved: boolean };

/** A command as configured: the value in your config file, and the one in effect here and where it's from. */
export type CommandSetting = { yours: string | null; effective: { run: string; from: string } | null };
export type CommandSettings = { file: string; editable: boolean; checkout: CommandSetting; editor: CommandSetting };

/** Claude Code's sign-in, as the page sees it. */
export type AuthStatus = {
  installed: boolean;
  loggedIn: boolean;
  method: string | null;
  /** An API key is saved in nit (your keychain). The key itself never leaves the server. */
  hasKey: boolean;
};

/** A run or job that failed because Claude needs signing in again carries exactly this error. */
export const SIGN_IN_ERROR = "Claude isn't signed in, or its sign-in expired.";
export const API_KEY_ERROR = "The API key saved in nit was refused. Replace it in Settings → Claude.";

export type Job = {
  id: string;
  kind: "review" | "ask" | "guide";
  state: "running" | "done" | "stopped" | "failed";
  startedAt: number;
  endedAt: number | null;
  error: string | null;
  /** review: proposals kept, and findings dropped by nit's checks (with why). */
  found: number;
  dropped: { reason: string; body: string }[];
  summary: string | null;
  /** ask: where, the question, and the answer as it streams. */
  at: { path: string; side: Side; start: number; end: number } | null;
  question: string | null;
  answer: string;
  /** ask: the session a follow-up question continues. */
  sessionId: string | null;
  /** Guidelines Claude had: in the prompt, and listed for it to read. */
  guidelines: { inline: string[]; indexed: number };
};

/** The live stream while the agent works. */
export type AgentEvent =
  | { type: "run"; run: AgentRun }
  | { type: "job"; job: Job }
  | { type: "delta"; text: string }
  | { type: "text"; text: string }
  | { type: "tool"; tool: string; target: string };

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentRun, AskThread, Draft, Proposal } from "./types";

export function dataDir() {
  return process.env.NIT_DATA_DIR ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "nit");
}

type DraftRow = {
  id: string;
  path: string;
  side: Draft["side"];
  start_line: number;
  end_line: number;
  body: string;
  suggestion: string | null;
  anchor: string;
  reply_to: string | null;
  proposal: string | null;
  created_at: number;
  updated_at: number;
};

const toDraft = (r: DraftRow): Draft => ({
  id: r.id,
  path: r.path,
  side: r.side,
  start: r.start_line,
  end: r.end_line,
  body: r.body,
  suggestion: r.suggestion,
  anchor: JSON.parse(r.anchor),
  replyTo: r.reply_to,
  proposal: r.proposal ? (JSON.parse(r.proposal) as Proposal) : null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** All of one review's state, keyed by project + branch so it outlives the worktree. */
export function openStore(review: string) {
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "nit.db"), { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 3000");
  db.run("PRAGMA synchronous = NORMAL"); // safe with WAL; skips an fsync per write
  db.run(`create table if not exists draft (
    id text primary key,
    review text not null,
    path text not null,
    side text not null check (side in ('additions', 'deletions')),
    start_line integer not null,
    end_line integer not null,
    body text not null,
    suggestion text,
    anchor text not null,
    reply_to text,
    created_at integer not null,
    updated_at integer not null
  )`);
  db.run("create index if not exists draft_review on draft (review)");
  // Databases created before replies existed get the column added once.
  if (
    !db
      .query<{ name: string }, []>("select name from pragma_table_info('draft')")
      .all()
      .some((c) => c.name === "reply_to")
  )
    db.run("alter table draft add column reply_to text");
  if (
    !db
      .query<{ name: string }, []>("select name from pragma_table_info('draft')")
      .all()
      .some((c) => c.name === "proposal")
  )
    db.run("alter table draft add column proposal text");
  db.run(`create table if not exists viewed (
    review text not null,
    path text not null,
    primary key (review, path)
  )`);
  // What a file's diff was when it was marked viewed (a hash) and its text then, so a later
  // change unmarks it and can be shown on its own. Rows from before have neither.
  for (const col of ["hash", "content"])
    if (
      !db
        .query<{ name: string }, []>("select name from pragma_table_info('viewed')")
        .all()
        .some((c) => c.name === col)
    )
      db.run(`alter table viewed add column ${col} text`);

  // User settings (the theme): shared by every review, unlike the rest of this file.
  db.run("create table if not exists setting (key text primary key, value text not null)");
  const getSetting = db.query<{ value: string }, [string]>("select value from setting where key = ?");
  // Goes up whenever another connection (another nit) commits to this database.
  const dataVersion = db.query<{ data_version: number }, []>("PRAGMA data_version");
  const putSetting = db.query(
    "insert into setting (key, value) values (?, ?) on conflict (key) do update set value = excluded.value",
  );

  // Questions you asked Claude, kept per review.
  db.run(`create table if not exists ask_thread (
    review text not null,
    id text not null,
    value text not null,
    updated_at integer not null,
    primary key (review, id)
  )`);
  const listAsks = db.query<{ value: string }, [string]>(
    "select value from ask_thread where review = ? order by updated_at desc",
  );
  const putAsk = db.query(
    "insert into ask_thread (review, id, value, updated_at) values (?, ?, ?, ?) on conflict (review, id) do update set value = excluded.value, updated_at = excluded.updated_at",
  );
  const removeAsk = db.query("delete from ask_thread where review = ? and id = ?");

  // The last agent pass for each review (results and undo outlive a restart).
  db.run("create table if not exists agent_run (review text primary key, value text not null)");
  const getRun = db.query<{ value: string }, [string]>("select value from agent_run where review = ?");
  const putRun = db.query(
    "insert into agent_run (review, value) values (?, ?) on conflict (review) do update set value = excluded.value",
  );

  const listDrafts = db.query<DraftRow, [string]>("select * from draft where review = ? order by path, start_line");
  const getDraft = db.query<DraftRow, [string, string]>("select * from draft where review = ? and id = ?");
  const upsert =
    db.query(`insert into draft (id, review, path, side, start_line, end_line, body, suggestion, anchor, reply_to, proposal, created_at, updated_at)
    values ($id, $review, $path, $side, $start, $end, $body, $suggestion, $anchor, $replyTo, $proposal, $createdAt, $updatedAt)
    on conflict (id) do update set body = excluded.body, suggestion = excluded.suggestion,
      start_line = excluded.start_line, end_line = excluded.end_line, side = excluded.side,
      anchor = excluded.anchor, proposal = excluded.proposal, updated_at = excluded.updated_at
    where draft.review = excluded.review`);
  const remove = db.query("delete from draft where review = ? and id = ?");
  const listViewed = db.query<{ path: string; hash: string | null }, [string]>(
    "select path, hash from viewed where review = ?",
  );
  const viewedText = db.query<{ content: string | null }, [string, string]>(
    "select content from viewed where review = ? and path = ?",
  );
  const addViewed = db.query(
    "insert into viewed (review, path, hash, content) values (?, ?, ?, ?) on conflict (review, path) do update set hash = excluded.hash, content = excluded.content",
  );
  const removeViewed = db.query("delete from viewed where review = ? and path = ?");

  return {
    drafts: () => listDrafts.all(review).map(toDraft),
    draft: (id: string) => {
      const row = getDraft.get(review, id);
      return row ? toDraft(row) : null;
    },
    saveDraft: (d: Draft) => {
      upsert.run({
        ...d,
        review,
        anchor: JSON.stringify(d.anchor),
        replyTo: d.replyTo ?? null,
        proposal: d.proposal ? JSON.stringify(d.proposal) : null,
      });
    },
    deleteDraft: (id: string) => {
      remove.run(review, id);
    },
    agentRun: (): AgentRun | null => {
      const row = getRun.get(review);
      return row ? (JSON.parse(row.value) as AgentRun) : null;
    },
    setAgentRun: (run: AgentRun) => {
      putRun.run(review, JSON.stringify(run));
    },
    /** Changes when another process writes to the database: how one nit hears another's changes. */
    dataVersion: () => dataVersion.get()?.data_version ?? 0,
    setting: (key: string): unknown => {
      const row = getSetting.get(key);
      return row ? JSON.parse(row.value) : null;
    },
    setSetting: (key: string, value: unknown) => {
      putSetting.run(key, JSON.stringify(value));
    },
    asks: (): AskThread[] => listAsks.all(review).map((r) => JSON.parse(r.value) as AskThread),
    saveAsk: (t: AskThread) => {
      putAsk.run(review, t.id, JSON.stringify(t), t.updatedAt);
    },
    deleteAsk: (id: string) => {
      removeAsk.run(review, id);
    },
    viewed: () => listViewed.all(review),
    /** The file's text when it was marked viewed, if kept. */
    viewedText: (path: string) => viewedText.get(review, path)?.content ?? null,
    setViewed: (path: string, viewed: boolean, hash: string | null = null, content: string | null = null) => {
      if (viewed) addViewed.run(review, path, hash, content);
      else removeViewed.run(review, path);
    },
  };
}

export type Store = ReturnType<typeof openStore>;

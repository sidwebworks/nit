import { QueryClient, queryOptions, useQuery } from "@tanstack/react-query";
import type { Symbol as Sym } from "../types";
import { type At, api } from "./api";
import * as st from "./state";

/**
 * Server data the page reads, cached by TanStack Query. Most of it is fixed for one version of
 * the review, so its key holds that version (`rev`, a hash of the diff): a reload that changes
 * the diff starts fresh, an unchanged one keeps everything, and nothing needs clearing by hand.
 * Entries nobody is using are dropped after a few minutes, so big files don't pile up.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: Number.POSITIVE_INFINITY, // the key says when it changes
      retry: 1, // nit's server is local: a second failure won't be a fluke
      refetchOnWindowFocus: false, // the review reloads itself when you come back (main.tsx)
    },
  },
});

/** Both sides of a file's text at this version of the review. */
export const fileQuery = (rev: string, path: string, prev?: string) =>
  queryOptions({ queryKey: ["file", rev, path, prev ?? ""], queryFn: () => api.file(path, prev) });

/** A file's outline; the old side only when the diff needs it. */
export const symbolsQuery = (rev: string, path: string, prev: string | undefined, withOld: boolean) =>
  queryOptions({
    queryKey: ["symbols", rev, path, prev ?? "", withOld],
    queryFn: () => api.symbols(path, prev, withOld),
  });

/** The identifiers on one line, for ⌘-hover links. A failure means none, not an error. */
export const identifiersQuery = (rev: string, at: At) =>
  queryOptions({
    queryKey: ["identifiers", rev, at.path, at.side, at.line],
    queryFn: () => api.identifiers(at).catch(() => []),
  });

// Live statuses (a sign-in, a saved key, your config): read again whenever a screen shows them,
// with the last answer on screen meanwhile.
const live = { staleTime: 0 } as const;
export const claudeAuthQuery = queryOptions({ queryKey: ["auth", "claude"], queryFn: api.auth, ...live });
export const codexAuthQuery = queryOptions({ queryKey: ["auth", "codex"], queryFn: api.codexAuth, ...live });
export const githubAccountQuery = queryOptions({ queryKey: ["github-account"], queryFn: api.githubAccount, ...live });
export const linearKeyQuery = queryOptions({ queryKey: ["linear-key"], queryFn: api.linearKey, ...live });
export const commandsQuery = queryOptions({ queryKey: ["commands"], queryFn: api.commands, ...live });

export type Outline = { new: Sym[] | null; old: Sym[] | null };
const NONE: Outline = { new: null, old: null };

/**
 * A file's outline, or undefined while it loads. One that can't be read is an empty outline
 * ("No outline for this file type"), not a wait that never ends.
 */
export function useOutline(path: string | undefined, prev?: string, withOld = true): Outline | undefined {
  const rev = st.useStore((s) => s.rev);
  const q = useQuery({ ...symbolsQuery(rev, path ?? "", prev, withOld), enabled: !!path });
  return q.isError ? NONE : q.data;
}

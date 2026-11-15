import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ChatLines,
  ChatPlusIn,
  Check,
  CheckCircle,
  CodeBracketsSquare,
  DocMagnifyingGlass,
  EditPencil,
  Expand,
  GitPullRequest,
  List,
  NavArrowDown,
  NavArrowUp,
  OpenNewWindow,
  Page,
  Refresh,
  Search,
  Settings,
  SidebarCollapse,
  SidebarExpand,
  Sparks,
  Trash,
  Undo,
  ViewColumns2,
} from "iconoir-react/regular";
import type { ReactNode } from "react";
import * as agent from "./agent";
import * as nav from "./nav";
import * as st from "./state";
import * as suggest from "./suggest";

export type Action = {
  id: string;
  label: string;
  group: "Review" | "Navigate" | "View";
  /** Shown in the palette and tooltips; also what handleKey matches. */
  keys: string[];
  icon: ReactNode;
  run: () => void;
  when?: () => boolean;
  /** Keyboard-only helpers (moving the cursor) stay out of the palette. */
  hidden?: boolean;
};

// In a file opened outside the review only navigation applies: nothing there to comment on.
const BROWSE = new Set([
  "line-down",
  "line-up",
  "definition",
  "references",
  "back",
  "outline",
  "files",
  "sidebar",
  "settings",
  "search",
  "review",
  "agent-apply",
  "agent-panel",
  "next-file",
  "prev-file",
  "reload",
]);

/** Whether an action can run right now (the palette lists only these). */
export const available = (a: Action) => (!a.when || a.when()) && (!st.get().browse || BROWSE.has(a.id));

const focusedDraft = () => st.get().drafts.find((d) => d.id === st.get().focused);
const focusedThread = () => {
  const gh = st.get().github;
  return gh?.status === "ready" ? gh.threads.find((t) => t.id === st.get().focused) : undefined;
};

/** One list for the keyboard and the palette: every action has a key, every key is discoverable. */
export const actions: Action[] = [
  {
    id: "comment",
    group: "Review",
    label: "Comment on selected lines",
    keys: ["c"],
    icon: <ChatPlusIn />,
    run: st.startComment,
  },
  {
    id: "comment-file",
    group: "Review",
    label: "Comment on file",
    keys: ["C"],
    icon: <ChatLines />,
    run: st.startFileComment,
  },
  {
    id: "viewed",
    group: "Review",
    label: "Mark file as viewed",
    keys: ["v"],
    icon: <CheckCircle />,
    run: () => st.toggleViewed(),
  },
  {
    id: "next-comment",
    group: "Review",
    label: "Next comment",
    keys: ["]"],
    icon: <NavArrowDown />,
    run: () => st.jumpDraft(1),
  },
  {
    id: "prev-comment",
    group: "Review",
    label: "Previous comment",
    keys: ["["],
    icon: <NavArrowUp />,
    run: () => st.jumpDraft(-1),
  },
  {
    id: "edit-comment",
    group: "Review",
    label: "Edit comment",
    keys: ["e"],
    icon: <EditPencil />,
    when: () => !!focusedDraft(),
    run: () => st.editDraft(st.get().focused!),
  },
  {
    id: "delete-comment",
    group: "Review",
    label: "Delete comment",
    keys: ["Backspace"],
    icon: <Trash />,
    when: () => !!focusedDraft(),
    run: () => st.removeDraft(st.get().focused!),
  },
  {
    id: "apply-suggestion",
    group: "Review",
    label: "Apply suggestion to working tree",
    keys: ["a"],
    icon: <CheckCircle />,
    when: () => focusedDraft()?.suggestion != null,
    run: () => void st.applySuggestion(st.get().focused!),
  },
  {
    id: "review",
    group: "Review",
    label: "Review all comments",
    keys: ["Mod+Shift+Enter"],
    icon: <ChatLines />,
    run: () => st.set((s) => ({ reviewOpen: !s.reviewOpen })),
  },
  {
    id: "agent-apply",
    group: "Review",
    label: "Apply comments with AI",
    keys: ["Mod+Shift+a"],
    icon: <Sparks />,
    when: () => st.get().agent?.state !== "running" && st.get().drafts.some((d) => !d.replyTo),
    run: () => void agent.apply(),
  },
  {
    id: "coreview",
    group: "Review",
    label: "Co-review the diff",
    keys: [],
    icon: <Sparks />,
    when: () => st.get().agent?.state !== "running" && st.get().job?.state !== "running",
    run: () => void agent.coreview(),
  },
  {
    id: "pull-request",
    group: "Review",
    label: "Pull request: description and checks",
    keys: [],
    icon: <GitPullRequest />,
    when: () => st.get().github?.status === "ready",
    run: () => st.set({ prOpen: true }),
  },
  {
    id: "guide",
    group: "Review",
    label: "Guide me through this pull request",
    keys: [],
    icon: <Sparks />,
    when: () => st.get().agent?.state !== "running" && st.get().job?.state !== "running",
    run: () => void agent.guide(),
  },
  {
    id: "ask",
    group: "Review",
    label: "Ask about these lines",
    keys: ["Mod+i"],
    icon: <Sparks />,
    when: () => !!st.get().cursor && !st.get().browse,
    run: agent.startAsk,
  },
  {
    id: "accept-proposal",
    group: "Review",
    label: "Accept the proposed comment",
    keys: ["y"],
    icon: <Check />,
    when: () => !!focusedDraft()?.proposal,
    run: () => agent.accept(st.get().focused!),
  },
  {
    id: "agent-panel",
    group: "Review",
    label: "AI: questions and passes",
    keys: ["Mod+Shift+i"],
    icon: <Sparks />,
    when: () => st.get().agent !== null || st.get().asks.length > 0 || st.get().job !== null,
    run: () => st.set({ agentOpen: true }),
  },
  {
    id: "suggest",
    group: "Review",
    label: "Suggest a change to these lines",
    keys: ["Mod+Shift+s"],
    icon: <EditPencil />,
    when: () => st.get().cursor?.side === "additions",
    run: () => {
      st.startComment();
      const id = st.get().editing;
      if (id) void suggest.start(id);
    },
  },
  {
    id: "search",
    group: "Navigate",
    label: "Search the repo",
    keys: ["Mod+Shift+f"],
    icon: <DocMagnifyingGlass />,
    run: nav.openSearch,
  },
  {
    id: "settings",
    group: "View",
    label: "Theme and appearance",
    keys: ["Mod+,"],
    icon: <Settings />,
    run: () => st.set((s) => ({ settingsOpen: !s.settingsOpen })),
  },
  {
    id: "reply",
    group: "Review",
    label: "Reply to thread",
    keys: ["r"],
    icon: <ChatLines />,
    when: () => !!focusedThread(),
    run: () => st.replyTo(focusedThread()!.id),
  },
  {
    id: "resolve",
    group: "Review",
    label: "Resolve or reopen thread",
    keys: ["x"],
    icon: <CheckCircle />,
    when: () => !!focusedThread(),
    run: () => {
      const t = focusedThread()!;
      void st.setThreadResolved(t.id, !t.resolved);
    },
  },
  { id: "undo", group: "Review", label: "Undo", keys: ["Mod+z"], icon: <Undo />, when: st.canUndo, run: st.undo },

  {
    id: "next-file",
    group: "Navigate",
    label: "Next file",
    keys: ["j"],
    icon: <ArrowDown />,
    run: () => st.stepFile(1),
  },
  {
    id: "prev-file",
    group: "Navigate",
    label: "Previous file",
    keys: ["k"],
    icon: <ArrowUp />,
    run: () => st.stepFile(-1),
  },
  {
    id: "next-change",
    group: "Navigate",
    label: "Next change",
    keys: ["n"],
    icon: <NavArrowDown />,
    run: () => st.nextChange(1),
  },
  {
    id: "prev-change",
    group: "Navigate",
    label: "Previous change",
    keys: ["p"],
    icon: <NavArrowUp />,
    run: () => st.nextChange(-1),
  },
  {
    id: "files",
    group: "Navigate",
    label: "Go to file",
    keys: ["Mod+p"],
    icon: <Page />,
    run: () => st.set({ palette: "files" }),
  },
  {
    id: "line-down",
    group: "Navigate",
    label: "Next line",
    keys: ["ArrowDown"],
    icon: null,
    hidden: true,
    run: () => st.moveCursor(1),
  },
  {
    id: "line-up",
    group: "Navigate",
    label: "Previous line",
    keys: ["ArrowUp"],
    icon: null,
    hidden: true,
    run: () => st.moveCursor(-1),
  },
  {
    id: "extend-down",
    group: "Navigate",
    label: "Extend selection down",
    keys: ["Shift+ArrowDown"],
    icon: null,
    hidden: true,
    run: () => st.moveCursor(1, true),
  },
  {
    id: "extend-up",
    group: "Navigate",
    label: "Extend selection up",
    keys: ["Shift+ArrowUp"],
    icon: null,
    hidden: true,
    run: () => st.moveCursor(-1, true),
  },

  {
    id: "full-file",
    group: "View",
    label: "Show whole file / fold unchanged",
    keys: ["f"],
    icon: <Expand />,
    run: () => {
      const f = st.currentFile();
      if (f) void st.setFullFile(f.name, !st.get().fullFiles.has(f.name));
    },
  },
  {
    id: "style",
    group: "View",
    label: "Toggle split / unified",
    keys: ["s"],
    icon: <ViewColumns2 />,
    run: st.toggleStyle,
  },
  {
    id: "sidebar",
    group: "View",
    label: "Toggle file list",
    keys: ["Mod+\\"],
    icon: <SidebarCollapse />,
    run: () => st.set((s) => ({ sidebar: !s.sidebar })),
  },
  { id: "reload", group: "View", label: "Reload changes", keys: ["r"], icon: <Refresh />, run: () => void st.load() },
  {
    id: "outline",
    group: "View",
    label: "Toggle outline",
    keys: ["O"],
    icon: <SidebarExpand />,
    run: () => st.set((s) => ({ outlineOpen: !s.outlineOpen })),
  },

  {
    id: "definition",
    group: "Navigate",
    label: "Go to definition",
    keys: ["g d"],
    icon: <CodeBracketsSquare />,
    run: () => void nav.lookup("definition"),
  },
  {
    id: "references",
    group: "Navigate",
    label: "Find references",
    keys: ["g r"],
    icon: <Search />,
    run: () => void nav.lookup("references"),
  },
  {
    id: "symbols",
    group: "Navigate",
    label: "Go to symbol in file",
    keys: ["@"],
    icon: <List />,
    run: () => st.set({ palette: "symbols" }),
  },
  { id: "back", group: "Navigate", label: "Go back", keys: ["Mod+["], icon: <ArrowLeft />, run: nav.goBack },
  {
    id: "open-in-editor",
    group: "Navigate",
    label: "Open in editor",
    keys: ["o"],
    icon: <OpenNewWindow />,
    run: () => void nav.openInEditor(),
  },
];

const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);

export function keyName(e: KeyboardEvent) {
  const parts = [];
  if (e.metaKey || e.ctrlKey) parts.push("Mod");
  // Shift is part of the name for named keys and with a modifier (⌘⇧F); a bare shifted
  // letter is already its capital.
  if (e.shiftKey && (e.key.length > 1 || e.metaKey || e.ctrlKey || e.altKey)) parts.push("Shift");
  if (e.altKey) parts.push("Alt");
  // Single characters keep their case ("C" is ⇧C) unless a modifier is held.
  parts.push(e.key.length === 1 && (e.metaKey || e.ctrlKey || e.altKey) ? e.key.toLowerCase() : e.key);
  return parts.join("+");
}

export function keyLabel(k: string) {
  return k
    .replace(/\+([a-z])$/, (_, c: string) => `+${c.toUpperCase()}`)
    .replace("Mod+", isMac ? "⌘" : "Ctrl+")
    .replace("Shift+", "⇧")
    .replace("Enter", "↵")
    .replace("ArrowDown", "↓")
    .replace("ArrowUp", "↑")
    .replace("Backspace", "⌫")
    .replace(/^([A-Z])$/, "⇧$1");
}

let pendingG = 0;

/**
 * Capture phase, ahead of Pierre's editor: while suggesting, ⌘↵ keeps the edit and Esc drops
 * it. Otherwise the editor would act on them first (⌘↵ inserts a line).
 */
export function handleSuggestKey(e: KeyboardEvent) {
  if (!st.get().suggesting) return;
  const name = keyName(e);
  if (name !== "Mod+Enter" && e.key !== "Escape") return;
  e.preventDefault();
  e.stopPropagation();
  suggest.finish(name === "Mod+Enter");
}

export function handleKey(e: KeyboardEvent) {
  const s = st.get();
  const name = keyName(e);
  // The real target: editors inside a shadow root (Pierre's) report their host as e.target.
  const inner = e.composedPath()[0];
  const el = inner instanceof HTMLElement ? inner : e.target instanceof HTMLElement ? e.target : null;
  const typing = !!el && (el.isContentEditable || !!el.closest("input, textarea, [contenteditable=true]"));
  // While a suggestion is being typed into the diff, the editor has the keyboard
  // (handleSuggestKey takes ⌘↵ and Esc before it).
  if (s.suggesting) return;
  // Inside the comment editor ⌘K inserts a link, as on GitHub.
  if (name === "Mod+k" && el?.closest("[data-md-editor]")) return;
  if (name === "Mod+k" || name === "Mod+p") {
    e.preventDefault();
    st.set({ palette: s.palette ? null : name === "Mod+p" ? "files" : "all" });
    return;
  }
  // The palette and the composer handle their own keys. While a composer is open, stray
  // letters typed before it takes focus must not trigger actions.
  if (name === "Mod+Shift+Enter" && !s.editing) {
    e.preventDefault();
    st.set({ reviewOpen: !s.reviewOpen });
    return;
  }
  // Search opens from anywhere but a composer, even from the palette.
  if (name === "Mod+Shift+f" && !s.editing) {
    e.preventDefault();
    if (s.searchOpen) nav.closeSearch();
    else nav.openSearch();
    return;
  }
  // An open composer closes on Esc even after focus has left it (an empty one disappears).
  if (s.editing && !typing && e.key === "Escape" && !s.palette && !s.searchOpen) {
    e.preventDefault();
    st.finishEditing();
    return;
  }
  // The side sheets close on Esc wherever focus is: Silk only hears keys from inside a sheet.
  if (e.key === "Escape" && (s.agentOpen || s.prOpen) && !s.palette && !typing) {
    e.preventDefault();
    st.set({ agentOpen: false, prOpen: false });
    return;
  }
  // The sheets trap focus and handle their own keys.
  if (s.palette || typing || s.editing || s.reviewOpen || s.settingsOpen || s.searchOpen || s.agentOpen || s.prOpen)
    return;
  if (e.key === "Escape") {
    if (s.asking) st.set({ asking: null });
    else if (s.peek) nav.closePeek();
    else if (s.marking) st.set({ marking: false });
    else if (s.browse) nav.goBack();
    else if (s.view === "agent") st.set({ view: "review" });
    else if (s.anchor || s.focused) st.set({ anchor: null, focused: null });
    return;
  }
  // Two-key sequences: g then d or r, within a second.
  if (pendingG && performance.now() - pendingG < 1000 && (name === "d" || name === "r")) {
    pendingG = 0;
    e.preventDefault();
    void nav.lookup(name === "d" ? "definition" : "references");
    return;
  }
  pendingG = name === "g" ? performance.now() : 0;
  if (name === "g") {
    e.preventDefault();
    return;
  }
  if (e.key === "?") {
    e.preventDefault();
    st.set({ palette: "all" });
    return;
  }
  // The first action for this key that applies right now (r replies on a thread, else reloads).
  const action = actions.find(
    (a) => (a.keys.includes(name) || (name === "Delete" && a.keys.includes("Backspace"))) && available(a),
  );
  if (!action) return;
  e.preventDefault();
  action.run();
}

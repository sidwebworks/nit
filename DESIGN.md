# nit design

## Goal

nit sits inside a loop the engineer already has:

```
terminal → nit → read, comment → editor | agent | GitHub → terminal
```

nit has done its job when that loop gets shorter and nobody notices the tool.
Every element on screen must earn its place against that test. When in doubt,
leave it out.

## Principles

1. **The diff is the product.** Everything else is quiet, small and grey. Colour
   means something has changed or needs attention: additions, deletions,
   draft comments.
2. **Keyboard first, mouse welcome.** Every action has a key. The mouse works
   everywhere, but no action needs it.
3. **One surface per job.** `⌘K` holds every action, file and shortcut. There
   are no menus, no toolbars and no settings page.
4. **Instant.** Nothing that a key opens is animated. The tab is usable before
   you look at it.
5. **Remembers, never asks.** Viewed files, drafts, layout and position persist
   per branch. There are no setup screens, no onboarding and no confirmations,
   except before posting to GitHub or running the agent.
6. **Hand off, don't absorb.** Editing goes to your editor (`o`), changes go to
   the agent, and the review goes to GitHub. nit never becomes an IDE.

## Layout

```
┌────────────┬──────────────────────────────────────────────────┐
│ feature    │ src/auth/token.ts                 +3 −1   ✓ Viewed │  ← sticky file header
│ → main     ├──────────────────────────────────────────────────┤
│            │                                                  │
│ 2/7 ▬▬▬──  │   diff (split or unified)                        │
│            │                                                  │
│ M token.ts │   ┃ 12  if (!env) throw new Error(…)             │
│ M client.ts│   ┃ ┌──────────────────────────────────────┐     │  ← inline draft comment
│ A api.ts   │   ┃ │ Draft · throw here breaks callers…   │     │
│ ●          │   ┃ └──────────────────────────────────────┘     │
│            │                                                  │
│            │                                                  │
│ 3 drafts   │                                                  │
│ ⌘K         │                                                  │
└────────────┴──────────────────────────────────────────────────┘
```

Two regions only.

- **File list (240px, `⌘\` hides it).** Top: branch → base and a thin
  progress bar for viewed files. Rows: a status letter (A, M, D, R), the file
  name, a grey directory, and `+n −n` aligned right. A dot marks files with
  drafts. Viewed files turn grey. Bottom: the draft count, which opens the
  submit step, and a `⌘K` hint.
- **Diff.** One file at a time, with a sticky header: path, `+n −n`, and a
  Viewed toggle. Everything else lives in `⌘K`.

No top bar, status bar or tabs. One exception to "two regions": the
**outline** (`⇧O`), a right-hand panel of the file's symbols. Code structure
is too important in review to hide behind a key. Dots mark symbols the diff
added (green) or changed (amber); removed symbols are listed at the bottom.
It remembers whether you closed it.

## What appears, and when

| Thing | When it appears | Form |
|---|---|---|
| Line cursor | Always, in the diff | A faint row highlight moved with `↑`/`↓`. `⇧↑`/`⇧↓` extends it to a range. |
| Comment composer | `c`, or clicking the gutter `+` | Inline under the line. `⌘↵` saves, `Esc` cancels. |
| Draft comment | After saving | Inline card with an amber left edge and the word "Draft". Edit or delete appear on hover or focus. |
| Definition / references peek | `gd` / `gr`, or `⌘`-click on a word | Inline under the line, up to 12 lines, `Esc` closes. References are grouped as changed here or not touched. |
| Command palette | `⌘K` (`⌘P` opens it on files) | Centred, 560px. Files, actions and shortcuts in one list. |
| Submit review | `⌘⇧↵`, or clicking the draft count | Small dialog: verdict (Comment / Approve / Request changes), an optional summary, the draft count, and Post. |
| Agent running | After "Apply comments" | Replaces the draft count with "Applying 3 comments…" and a spinner. When done, the file list shows only files changed since the last pass, with a "Show all" link. |
| Toast | Only for results that happen away from the cursor, like "Review posted · open on GitHub" | Bottom-left, 4 seconds, one at a time. |

Not in v1: a file tree, a settings page, theme pickers, a help overlay (`?`
opens `⌘K` filtered to shortcuts), avatars or a notification centre.

## Comments: the reason to use nit

Commenting is what reviewers do most, and it's where GitHub is weakest. Each
row is a GitHub problem and nit's answer.

| GitHub today | nit |
|---|---|
| Two buttons, "Add single comment" and "Start a review". A wrong click notifies people early. | One kind of comment: a draft. Nothing leaves your machine until you submit. |
| Text is lost on reload, or a pending review gets stuck in another tab. | The composer saves to disk as you type. Drafts survive restarts, crashes and branch switches. |
| Commenting on a range means a tiny `+` and shift-click. | `c` on the cursor line, `⇧↑`/`⇧↓` to extend, or drag across line numbers. |
| Suggestions mean typing a ```` ```suggestion ```` block by hand. | `⌘⇧S` in the composer fills in the selected lines to edit. The card shows a small before/after. |
| You can't apply a suggestion locally without pushing. | `a` on a suggestion card applies it to your working tree. No agent needed: it's an exact edit. |
| Comments go "outdated" and hide when the code changes. | Each draft remembers its line text and nearby lines, and follows the code when it moves. If the code is gone, the draft stays visible and is marked "Code changed". It's never hidden. |
| There's no list of your own pending comments and no way to jump between them. | `]`/`[` jump between comments in the review. The submit step lists every draft by file, so you can check your review before posting. |
| Reading and resolving others' threads means scrolling and clicking. | On a PR, existing threads appear inline. `r` replies (as a draft), `x` resolves. |
| No signal of how serious a comment is. | Start a comment with `nit:`, `question:` or `blocking:` and the card shows a small label. The agent handles blocking comments first. The tool's name makes the habit easy. |

### Writing comments (built)

GitHub's full comment editor, kept quiet:

- **Markdown (GitHub flavour):** headings, bold, italic, strikethrough, inline
  and fenced code (highlighted with the diff's own themes), links and autolinks,
  bulleted, numbered and task lists, quotes, tables, images and rules. Raw HTML
  is not rendered and unsafe links are dropped.
- **Write / Preview** tabs (`⌘⇧P`).
- **Toolbar** in three groups (heading, bold, italic · quote, code, link ·
  bulleted, numbered, task list), each with a tooltip showing its key.
- **GitHub's shortcuts:** `⌘B`, `⌘I`, `⌘E` (code, or a fenced block over
  several lines), `⌘K` (link), `⌘⇧.` (quote), `⌘⇧8` / `⌘⇧7` (lists).
  Edits go through the browser's own editing commands, so `⌘Z` undoes them.
- **Smart lists:** Enter continues a bulleted, numbered or task list; Enter on
  an empty item ends it.
- **Paste a URL over selected text** to make a link.
- **Task lists stay live:** ticking a box in a finished comment updates its text.
- **File comments** (`⇧C`) sit above the first change. Comments on unchanged
  lines work after expanding them.
- **Suggestions** (`⌘⇧S`) show as a before/after diff and apply locally (`a`).
  They post to GitHub as a `suggestion` block.

Comes with posting to GitHub (phase 2), because each needs GitHub's API:
`@mention` and `#123` autocomplete, existing threads with reply and resolve,
and image uploads.

After an agent pass, each draft it acted on shows the change to its lines
right under the card. `x` marks it done. Anything not addressed stays open.

What we don't add: reactions, emoji pickers, @mention autocomplete,
a rich-text toolbar, or comment edit history. Comments are plain Markdown,
shown formatted in the card.

## Keyboard

| Key | Action |
|---|---|
| `j` / `k` | Next / previous file |
| `n` / `p` | Next / previous change in the file |
| `↑` / `↓`, `⇧↑` / `⇧↓` | Move the line cursor, extend to a range |
| `c` | Comment on the cursor line or range |
| `]` / `[` | Next / previous comment |
| `e` / `⌫` | Edit / delete the focused draft (undo with `⌘Z`, no confirmation) |
| `a` | Apply the focused suggestion to the working tree |
| `r` / `x` | Reply to / resolve the focused thread |
| `v` | Mark viewed and jump to the next unviewed file |
| `s` | Split / unified |
| `gd` / `gr` | Definition / references for the word at the cursor (choose from the line's words if there are several) |
| `⌘[` | Back |
| `o` | Open in your editor at the cursor line |
| `⌘K` / `⌘P` | Palette / files |
| `⌘⇧↵` | Submit review |
| `⌘\` | Hide the file list |
| `Esc` | Close whatever is on top |

Every key appears next to its action in `⌘K`. The palette is how people
learn the keys.

## Visual system

Dark is the default. Light follows the system setting. Both themes use the
same tokens.

**Neutrals.** Four background steps with the same hue as the text (slightly
cool), defined in OKLCH:
`--bg` (app), `--bg-raised` (file list, popovers), `--bg-hover`,
`--bg-active`. Borders are a single 1px `--line` at low contrast. There are
no shadows except under the palette and dialog.

**Text.** Three levels: `--fg` (primary), `--fg-2` (secondary, still WCAG AA on
`--bg`), `--fg-3` (counts, directories and hints only).

**Colour.** One accent, indigo, for focus and the current selection. Diff green
and red are soft, so long reviews don't tire the eyes. Amber is used only for
drafts. Nothing else is coloured.

**Type.**
- UI text is Inter Variable (bundled, works offline) at 13px, with 12px for
  secondary text. Counts use tabular numbers.
- Code uses the system monospace (`ui-monospace`, SF Mono) at 12.5px with
  20px lines.
- Only two weights, 400 and 500.

**Space.** A 4px grid. File rows are 28px tall. Radius is 6px on controls and
8px on the palette and dialog.

**Icons.** Almost none. Status is a letter. The only glyphs are a check, a
spinner, and the diff indicator bars.

## Motion

Motion appears only where something happens without a keypress.

| Element | Motion |
|---|---|
| Anything a key opens (palette, peek, composer, dialog, file switch) | None. |
| Toast | Enters 200ms with `cubic-bezier(0.23, 1, 0.32, 1)`, moving up 8px and fading in. Exits in 150ms. |
| Pressing a button with the mouse | `scale(0.98)`, 120ms. |
| Hover | Background colour only, 100ms. Only on devices with a precise pointer: `@media (hover: hover) and (pointer: fine)`. |
| Spinner | Fast and linear. |
| `prefers-reduced-motion` | The toast fades without moving. Nothing else changes. |

## Pierre diffs settings

```ts
{
  theme: { dark: "pierre-dark", light: "pierre-light" },
  themeType: "system",
  diffIndicators: "bars",        // quiet coloured bar instead of +/− characters
  lineDiffType: "word-alt",      // highlight changed words, not whole lines
  hunkSeparators: "line-info",   // "↕ 24 unchanged lines", click to expand
  disableFileHeader: true,       // nit draws its own sticky header
  enableGutterUtility: true,     // the "+" to start a comment
  enableLineSelection: true,     // drag across line numbers to pick a range
  lineHoverHighlight: "number",  // quiet hover, the cursor row is ours
}
```

Draft comments and peeks are drawn through `lineAnnotations` and
`renderAnnotation`. `onTokenClick` with `⌘` held runs go-to-definition. Pierre's
`--diffs-*` CSS variables are set from our tokens, so the diff and the app share
one background.

## Components

Beautiful UI (beautifului.dev, MIT) sets the visual bar: cool OKLCH greys,
hairline borders, soft layered shadows, and a little colour. It ships as a
shadcn-style registry, so components are copied into our code. They are demo
grade, though, and every copied piece gets reworked to the rules below before
it lands.

What we found reading its source:
- The search list filters but has no arrow keys, Enter or listbox roles.
- The glide hover animates `top` and `height` (layout, not transform) and also
  animates when focus moves by keyboard.
- Demo data is hard-coded, and the files assume Next.js (`"use client"`, `@/`
  paths).

| nit needs | Taken from | Rework before it lands |
|---|---|---|
| Design tokens | Beautiful UI `foundation.css` | Keep the light and dark OKLCH values. Rename to our token names. Drop rules for components we don't use. |
| File list hover | Beautiful UI `GlideMenu` | Move with `transform`, not `top`. Glide only on mouse; keyboard moves snap. |
| `⌘K` palette | Beautiful UI `SearchList` look | Full combobox: arrow keys, Enter, Esc, `aria-activedescendant`. Results from fff. No animation on open. |
| Agent run progress | Beautiful UI `TaskRows` and `ToolChips` | The status-bar item while the agent runs, and the list of edited files with `+n −n`. Real data from the Agent SDK stream. |
| Loading | Beautiful UI `Shimmer` | Shown only if loading takes over 150ms, so a fast load doesn't flash. |
| Selecting lines | Beautiful UI `SelectionActions` pattern | A small bar above a selected range: Comment, Suggest. Same keys as the keyboard map. |
| Diff, gutter "+", line selection, inline cards | `@pierre/diffs` | Theme through `--diffs-*` variables from our tokens. |
| Draft card, composer, submit dialog, toast, key hint | Ours | Built on the same tokens. |

Not taken: chat, prompt bar, recommendation cards, records and filter tables,
flowchart, insight cards and the fine-tune inspector. nit has no use for them.

**Styling:** Tailwind v4, so registry components copy in with little change.
Vite builds the page (React with its compiler, Tailwind through
`@tailwindcss/vite`). Dev dependencies only, no runtime cost.

### Libraries underneath (built)

Interactive pieces sit on proven libraries rather than hand-rolled behaviour:

- **Base UI** (`@base-ui/react`, MIT, headless): tooltips (one provider; after
  the first opens, neighbours open instantly), the command palette's dialog
  (focus trap, Esc, outside click), toggle groups (layout switch, outline
  filter), the Viewed toggle, the comment box's Write/Preview tabs, and
  toasts (stacking, timers paused on hover, swipe to dismiss).
- **Silk** (`@silk-hq/components`, used under its non-commercial licence as a
  personal open-source tool): the review sheet (`⌘⇧↵`), a side sheet listing
  every comment by file, with jump-to and "Copy as Markdown". In phase 2 it
  gains the verdict and "Post to GitHub".
- **Pierre diffs** for the diff, **iconoir** for icons, and **Beautiful UI's**
  tokens for colour, shadow and radius.

Styling stays ours: every library is unstyled and themed with the tokens above.

## Workhorse rules

These apply to every component, copied or ours. A component that fails one
doesn't ship.

- **Keyboard complete.** Every action has a key, and focus is always visible
  (a 2px accent ring).
- **Correct roles.** Lists are `listbox`, the palette is a `combobox`, the
  dialog traps focus, and Esc always closes the top layer.
- **No animation on keyboard actions.** Only `transform` and `opacity`
  animate. `prefers-reduced-motion` removes movement.
- **Big inputs stay fast.** 1,000-file PRs, 10,000-line files, binary files,
  renames and deleted files all render correctly. Long paths are cut in the
  middle (`apps/…/token.ts`) so the file name stays visible.
- **Nothing is lost.** Typed text saves to disk as you type. If the server
  restarts, the tab reconnects to the event stream and keeps its place.
- **Every state is designed.** Empty, loading, error and offline states each
  say what happened and what to do. No raw error strings.
- **Works offline.** Fonts and icons are bundled. Nothing loads from a CDN.

## Decisions

- **One file at a time, not one long scroll.** It matches the per-file Viewed
  workflow, keeps the page fast on large diffs, and makes `j`/`k` the main way
  to move. Revisit if reviewers keep asking for continuous scroll. Pierre's
  `CodeView` already supports it.
- **Dark first.** That's the reviewer's terminal and editor. Light comes for
  free from the same tokens.
- **Copy components, don't install a library.** Beautiful UI pieces are
  copied in and reworked to the workhorse rules. The rest are small pieces of
  our own on the same tokens.

## Build order

1. Tokens, the two-region shell, file rows, the sticky header and Pierre
   settings.
2. Line cursor and keyboard map.
3. Inline composer and draft cards (with the comments feature).
4. `⌘K` palette.
5. Submit dialog and toast (with posting to GitHub).
6. Peek (with navigation).

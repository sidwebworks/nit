import { Dialog } from "@base-ui/react/dialog";
import { Select } from "@base-ui/react/select";
import type { ColorMode, ColorScheme } from "@pierre/theming";
import {
  Check,
  Code,
  ColorFilter,
  GitCompare,
  Github as GitHubIcon,
  NavArrowDown,
  Page,
  Settings as SettingsIcon,
  Sparks,
  Xmark,
} from "iconoir-react/regular";
import { Fragment, type ReactNode, useEffect, useState } from "react";
import type { AuthStatus, CommandSetting, CommandSettings, GitHubAccount, Prefs } from "../types";
import { api } from "./api";
import * as st from "./state";
import { catalog, nameFor, theme, useTheme } from "./theme";
import { Button, IconButton, Kbd, TextSegmented } from "./ui";

// Shiki's themes have ids only (night-owl, github-dark-dimmed); show them as names.
const WORDS: Record<string, string> = { github: "GitHub", vs: "VS", vscode: "VS Code", gruvbox: "Gruvbox", hc: "HC" };
const pretty = (id: string) =>
  id
    .split("-")
    .map((w) => WORDS[w] ?? w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
const themeOptions = (scheme: ColorScheme) =>
  catalog.getThemes({ colorScheme: scheme }).map((t) => ({ value: t.name, label: t.displayName ?? pretty(t.name) }));

const MODES: { value: ColorMode; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

// ---------- controls

/** A dropdown in nit's look. */
function Choice<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  const shown = options.find((o) => o.value === value)?.label ?? value;
  return (
    <Select.Root items={options} value={value} onValueChange={(v) => v && onChange(v as T)}>
      <Select.Trigger
        aria-label={label}
        className="flex h-7 w-[200px] min-w-0 items-center gap-2 rounded-control bg-field px-2.5 text-left text-[12.5px] text-ink shadow-[inset_0_0_0_1px_var(--line)] outline-none transition-[box-shadow] duration-100 focus-visible:shadow-[inset_0_0_0_1px_var(--accent),0_0_0_3px_var(--accent-tint)] data-popup-open:shadow-[inset_0_0_0_1px_var(--line-strong)]"
      >
        <Select.Value className="min-w-0 flex-1 truncate">{() => shown}</Select.Value>
        <Select.Icon className="shrink-0 text-ink-3">
          <NavArrowDown width={13} height={13} />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner sideOffset={4} className="z-[60] outline-none" alignItemWithTrigger={false}>
          <Select.Popup className="max-h-[min(360px,var(--available-height))] min-w-(--anchor-width) origin-(--transform-origin) overflow-y-auto rounded-card bg-surface p-1 shadow-overlay outline-none transition-[opacity,scale] duration-150 ease-out-strong data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0">
            <Select.List>
              {options.map((o) => (
                <Select.Item
                  key={o.value}
                  value={o.value}
                  className="flex h-7 cursor-default items-center gap-2 rounded-[6px] pr-2 pl-2.5 text-[12.5px] text-ink-2 outline-none select-none data-highlighted:bg-hover-2 data-highlighted:text-ink data-selected:text-ink"
                >
                  <Select.ItemText className="min-w-0 flex-1 truncate">{o.label}</Select.ItemText>
                  <Select.ItemIndicator className="shrink-0 text-accent-ink">
                    <Check width={13} height={13} />
                  </Select.ItemIndicator>
                </Select.Item>
              ))}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}

function Switch({ on, onChange, label }: { on: boolean; onChange: (on: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={`relative h-[18px] w-[30px] shrink-0 rounded-full outline-none transition-[background-color] duration-150 focus-visible:shadow-[0_0_0_3px_var(--accent-tint)] ${on ? "bg-accent" : "bg-line-strong"}`}
    >
      <span
        className={`absolute top-[2px] left-[2px] size-[14px] rounded-full bg-white shadow-[0_1px_2px_oklch(0_0_0/0.3)] transition-transform duration-150 ease-out-strong ${on ? "translate-x-[12px]" : ""}`}
      />
    </button>
  );
}

function Stepper(o: { value: number; onChange: (v: number) => void; min: number; max: number; step: number }) {
  const btn =
    "flex size-6 items-center justify-center rounded-[6px] text-[14px] text-ink-2 disabled:opacity-40 [@media(hover:hover)]:hover:bg-hover-2 [@media(hover:hover)]:hover:text-ink";
  return (
    <div className="flex items-center gap-1 rounded-control bg-field p-0.5 shadow-[inset_0_0_0_1px_var(--line)]">
      <button
        type="button"
        aria-label="Smaller"
        className={btn}
        disabled={o.value <= o.min}
        onClick={() => o.onChange(Math.max(o.min, o.value - o.step))}
      >
        −
      </button>
      <span className="w-12 text-center font-mono text-[12px] text-ink tabular-nums">{o.value}px</span>
      <button
        type="button"
        aria-label="Larger"
        className={btn}
        disabled={o.value >= o.max}
        onClick={() => o.onChange(Math.min(o.max, o.value + o.step))}
      >
        +
      </button>
    </div>
  );
}

/** One setting: what it is and what it does on the left, its control on the right. */
function Row({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-13 items-center gap-6 px-4 py-2.5 shadow-[0_1px_0_var(--line-soft)] last:shadow-none">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] text-ink">{title}</div>
        {hint ? <div className="mt-0.5 text-[12px] leading-[17px] text-ink-3">{hint}</div> : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** Settings that belong together, in one rounded panel, with an optional heading. */
function Group({ title, note, children }: { title?: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-5 first:mt-1">
      {title ? <h3 className="mb-2 px-1 text-[11.5px] font-medium tracking-[0.01em] text-ink-3">{title}</h3> : null}
      <div className="overflow-hidden rounded-card bg-inset shadow-[inset_0_0_0_1px_var(--line)]">{children}</div>
      {note ? <p className="mt-2 px-1 text-[11.5px] leading-4 text-ink-3">{note}</p> : null}
    </section>
  );
}

// ---------- sections

function Appearance() {
  const t = useTheme();
  const size = st.useStore((s) => s.prefs.fontSize);
  return (
    <>
      <Group title="Colours">
        <Row title="Mode">
          <TextSegmented label="Colour mode" value={t.mode} onChange={(m) => theme.setColorMode(m)} options={MODES} />
        </Row>
        <Row title="Light theme" hint="Code and diff colours when nit is light.">
          <Choice
            label="Light theme"
            value={nameFor(t, "light")}
            options={themeOptions("light")}
            onChange={(v) => theme.setThemeNameForScheme("light", v)}
          />
        </Row>
        <Row title="Dark theme" hint="Code and diff colours when nit is dark.">
          <Choice
            label="Dark theme"
            value={nameFor(t, "dark")}
            options={themeOptions("dark")}
            onChange={(v) => theme.setThemeNameForScheme("dark", v)}
          />
        </Row>
      </Group>
      <Group title="Text">
        <Row title="Code size" hint="Text size in the diff and in files.">
          <Stepper value={size} min={11} max={16} step={0.5} onChange={(fontSize) => st.setPrefs({ fontSize })} />
        </Row>
      </Group>
    </>
  );
}

function Diff() {
  const style = st.useStore((s) => s.style);
  const p = st.useStore((s) => s.prefs);
  return (
    <>
      <Group title="Layout">
        <Row title="Layout" hint="Side by side, or old and new lines together. s switches it.">
          <TextSegmented
            label="Diff layout"
            value={style}
            onChange={(v) => st.set({ style: v })}
            options={[
              { value: "split", label: "Split" },
              { value: "unified", label: "Unified" },
            ]}
          />
        </Row>
        <Row title="Wrap long lines" hint="Off, long lines scroll sideways.">
          <Switch label="Wrap long lines" on={p.wrap} onChange={(wrap) => st.setPrefs({ wrap })} />
        </Row>
      </Group>
      <Group title="Changes">
        <Row title="Changed lines" hint="How the gutter marks added and removed lines.">
          <TextSegmented<Prefs["indicators"]>
            label="Changed line markers"
            value={p.indicators}
            onChange={(indicators) => st.setPrefs({ indicators })}
            options={[
              { value: "bars", label: "Bars" },
              { value: "classic", label: "+ −" },
              { value: "none", label: "None" },
            ]}
          />
        </Row>
        <Row title="Changes within a line" hint="Highlight what changed inside a changed line.">
          <TextSegmented<Prefs["inlineChanges"]>
            label="Changes within a line"
            value={p.inlineChanges}
            onChange={(inlineChanges) => st.setPrefs({ inlineChanges })}
            options={[
              { value: "word", label: "Words" },
              { value: "char", label: "Characters" },
              { value: "none", label: "Off" },
            ]}
          />
        </Row>
      </Group>
    </>
  );
}

type Status = AuthStatus | null;

/** What a reviewer's status line says: signed in how, or what's missing. */
function statusOf(name: string, a: Status, usingKey: boolean) {
  if (!a) return { tone: "bg-ink-3", text: "Checking…" };
  if (!a.installed) return { tone: "bg-ink-3", text: `${name} isn't installed` };
  if (usingKey)
    return a.hasKey
      ? { tone: "bg-green", text: "Using your API key" }
      : { tone: "bg-orange", text: "No API key saved" };
  return a.loggedIn
    ? {
        tone: "bg-green",
        text: `Signed in${a.method ? ` · ${a.method === "claude.ai" ? "Claude subscription" : a.method}` : ""}`,
      }
    : { tone: "bg-orange", text: "Not signed in" };
}

/** One reviewer to pick: its name, who makes it, and whether it's ready. */
function ReviewerCard(o: {
  name: string;
  maker: string;
  selected: boolean;
  status: { tone: string; text: string };
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={o.selected}
      onClick={o.onPick}
      className={`flex flex-1 flex-col items-start gap-2.5 rounded-card px-4 py-3.5 text-left transition-[box-shadow,background-color] duration-150 ${
        o.selected
          ? "bg-accent-tint shadow-[inset_0_0_0_1.5px_var(--accent)]"
          : "bg-inset shadow-[inset_0_0_0_1px_var(--line)] [@media(hover:hover)]:hover:shadow-[inset_0_0_0_1px_var(--line-strong)]"
      }`}
    >
      <span className="flex w-full items-center gap-2">
        <span className="text-[13.5px] font-medium text-ink">{o.name}</span>
        <span className="text-[12px] text-ink-3">{o.maker}</span>
        <span
          className={`ml-auto flex size-4 items-center justify-center rounded-full ${o.selected ? "bg-accent text-white" : "shadow-[inset_0_0_0_1.5px_var(--line-strong)]"}`}
        >
          {o.selected ? <Check width={11} height={11} strokeWidth={2.5} /> : null}
        </span>
      </span>
      <span className="flex items-center gap-1.5 text-[12px] text-ink-2">
        <span className={`size-1.5 rounded-full ${o.status.tone}`} />
        {o.status.text}
      </span>
    </button>
  );
}

/**
 * Who reads the code with you: Claude Code or Codex. Each runs the one you installed, on your
 * own sign-in or an API key saved in your keychain.
 */
function Reviewer() {
  const p = st.useStore((s) => s.prefs);
  const [claude, setClaude] = useState<Status>(null);
  const [codex, setCodex] = useState<Status>(null);
  const check = () => {
    void api.auth().then(setClaude, () => {});
    void api.codexAuth().then(setCodex, () => {});
  };
  useEffect(check, []);
  const claudeStatus = statusOf("Claude Code", claude, p.auth === "apiKey");
  const codexStatus = statusOf("Codex", codex, p.codexAuth === "apiKey");
  return (
    <>
      <fieldset aria-label="Reviewer" className="mt-1 flex gap-3">
        <ReviewerCard
          name="Claude Code"
          maker="Anthropic"
          selected={p.reviewer === "claude"}
          status={claudeStatus}
          onPick={() => st.setPrefs({ reviewer: "claude" })}
        />
        <ReviewerCard
          name="Codex"
          maker="OpenAI"
          selected={p.reviewer === "codex"}
          status={codexStatus}
          onPick={() => st.setPrefs({ reviewer: "codex" })}
        />
      </fieldset>

      {p.reviewer === "claude" ? (
        <Group title="Claude Code">
          <Row title="Sign in with" hint="Claude Code's own login, or an Anthropic API key you save here.">
            <TextSegmented<Prefs["auth"]>
              label="Claude sign in"
              value={p.auth}
              onChange={(a) => st.setPrefs({ auth: a })}
              options={[
                { value: "login", label: "Claude account" },
                { value: "apiKey", label: "API key" },
              ]}
            />
          </Row>
          {p.auth === "login" ? (
            <Row
              title="Account"
              hint={
                <>
                  To sign in or switch accounts, run <code className="font-mono">claude</code> in a terminal and type{" "}
                  <code className="font-mono">/login</code>.
                </>
              }
            >
              <Button tone="secondary" onClick={check}>
                Check again
              </Button>
            </Row>
          ) : (
            <Row title="API key" hint="Kept in your keychain; billed to its Anthropic Console account.">
              <KeyField
                label="Anthropic API key"
                placeholder="sk-ant-…"
                missing="No key saved yet: Claude stops until you add one."
                saved={!!claude?.hasKey}
                store={async (key) => {
                  const { hasKey } = await api.saveClaudeKey(key);
                  setClaude((a) => (a ? { ...a, hasKey } : a));
                  return hasKey;
                }}
              />
            </Row>
          )}
          <Row title="Model" hint="Default is Claude Code's own choice.">
            <Choice<Prefs["model"]>
              label="Claude model"
              value={p.model}
              onChange={(model) => st.setPrefs({ model })}
              options={[
                { value: "default", label: "Default" },
                { value: "opus", label: "Opus" },
                { value: "sonnet", label: "Sonnet" },
                { value: "haiku", label: "Haiku" },
              ]}
            />
          </Row>
          <Row title="Effort" hint="Default answers questions at low effort, for speed, and co-reviews deeper.">
            <Choice<Prefs["effort"]>
              label="Claude effort"
              value={p.effort}
              onChange={(effort) => st.setPrefs({ effort })}
              options={[
                { value: "default", label: "Default" },
                { value: "low", label: "Low" },
                { value: "medium", label: "Medium" },
                { value: "high", label: "High" },
                { value: "xhigh", label: "Extra high" },
                { value: "max", label: "Max" },
              ]}
            />
          </Row>
        </Group>
      ) : (
        <Group title="Codex" note="Applying comments uses Claude Code for now; Codex answers, orders and co-reviews.">
          <Row title="Sign in with" hint="Codex's own login, or an OpenAI API key you save here.">
            <TextSegmented<Prefs["codexAuth"]>
              label="Codex sign in"
              value={p.codexAuth}
              onChange={(codexAuth) => st.setPrefs({ codexAuth })}
              options={[
                { value: "login", label: "ChatGPT account" },
                { value: "apiKey", label: "API key" },
              ]}
            />
          </Row>
          {p.codexAuth === "login" ? (
            <Row
              title="Account"
              hint={
                codex && !codex.installed ? (
                  <>
                    Install it with <code className="font-mono">npm i -g @openai/codex</code> or{" "}
                    <code className="font-mono">brew install codex</code>, then sign in.
                  </>
                ) : (
                  <>
                    To sign in or switch accounts, run <code className="font-mono">codex login</code> in a terminal.
                  </>
                )
              }
            >
              <Button tone="secondary" onClick={check}>
                Check again
              </Button>
            </Row>
          ) : (
            <Row title="API key" hint="Kept in your keychain; billed to its OpenAI account.">
              <KeyField
                label="OpenAI API key"
                placeholder="sk-…"
                missing="No key saved yet: Codex stops until you add one."
                saved={!!codex?.hasKey}
                store={async (key) => {
                  const { hasKey } = await api.saveCodexKey(key);
                  setCodex((a) => (a ? { ...a, hasKey } : a));
                  return hasKey;
                }}
              />
            </Row>
          )}
          <Row title="Model" hint="Empty is Codex's own default.">
            <TextField
              label="Codex model"
              value={p.codexModel}
              placeholder="Codex's default"
              onSave={(codexModel) => st.setPrefs({ codexModel })}
            />
          </Row>
          <Row title="Reasoning" hint="Default reasons lightly for questions, for speed, and deeper for co-review.">
            <Choice<Prefs["codexEffort"]>
              label="Codex reasoning effort"
              value={p.codexEffort}
              onChange={(codexEffort) => st.setPrefs({ codexEffort })}
              options={[
                { value: "default", label: "Default" },
                { value: "low", label: "Low" },
                { value: "medium", label: "Medium" },
                { value: "high", label: "High" },
                { value: "xhigh", label: "Extra high" },
              ]}
            />
          </Row>
        </Group>
      )}

      <Group title="Co-review">
        <Row title="Nitpicks" hint="Off, co-review proposes only issues and suggestions that matter.">
          <Switch label="Nitpicks in co-review" on={p.nits} onChange={(nits) => st.setPrefs({ nits })} />
        </Row>
      </Group>
    </>
  );
}

/** A short text setting, saved when you leave the field or press Enter. */
function TextField(o: { label: string; value: string; placeholder: string; onSave: (v: string) => void }) {
  const [text, setText] = useState(o.value);
  useEffect(() => setText(o.value), [o.value]);
  return (
    <input
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => text.trim() !== o.value && o.onSave(text.trim())}
      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      placeholder={o.placeholder}
      spellCheck={false}
      autoComplete="off"
      aria-label={o.label}
      className="h-7 w-[200px] rounded-control bg-field px-2.5 font-mono text-[12px] text-ink shadow-[inset_0_0_0_1px_var(--line)] outline-none placeholder:text-ink-3 focus:shadow-[inset_0_0_0_1px_var(--accent),0_0_0_3px_var(--accent-tint)]"
    />
  );
}

/** A secret saved to your keychain, never shown again: Enter saves, Remove deletes it. */
function KeyField({
  saved,
  store,
  label,
  placeholder,
  missing,
}: {
  saved: boolean;
  /** Saves (or with null removes) the value; resolves to whether one is saved now. */
  store: (value: string | null) => Promise<boolean>;
  label: string;
  placeholder: string;
  /** What not having one means, shown while none is saved. */
  missing?: string;
}) {
  const [text, setText] = useState("");
  const [state, setState] = useState<{ ok?: string; error?: string }>({});
  const save = async (key: string | null) => {
    try {
      const has = await store(key);
      setText("");
      setState({ ok: has ? "Saved to your keychain" : "Removed" });
    } catch (e) {
      setState({ error: e instanceof Error ? e.message : "Couldn't save the key." });
    }
  };
  return (
    <div className="w-[300px]">
      <div className="flex gap-1.5">
        <input
          type="password"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setState({});
          }}
          onKeyDown={(e) => e.key === "Enter" && text.trim() && void save(text.trim())}
          placeholder={saved ? "Saved · paste a new one to replace it" : placeholder}
          spellCheck={false}
          autoComplete="off"
          aria-label={label}
          className="h-7 min-w-0 flex-1 rounded-control bg-field px-2.5 font-mono text-[12px] text-ink shadow-[inset_0_0_0_1px_var(--line)] outline-none placeholder:font-sans placeholder:text-ink-3 focus:shadow-[inset_0_0_0_1px_var(--accent),0_0_0_3px_var(--accent-tint)]"
        />
        {text.trim() ? (
          <Button tone="secondary" onClick={() => void save(text.trim())}>
            Save
          </Button>
        ) : saved ? (
          <Button tone="ghost" onClick={() => void save(null)}>
            Remove
          </Button>
        ) : null}
      </div>
      <div className="mt-1 h-4 truncate text-[11.5px]">
        {state.error ? (
          <span className="text-red">{state.error}</span>
        ) : state.ok ? (
          <span className="text-green">{state.ok}</span>
        ) : !saved && missing ? (
          <span className="text-orange">{missing}</span>
        ) : null}
      </div>
    </div>
  );
}

function GitHub() {
  const [a, setA] = useState<GitHubAccount | null | undefined>(undefined);
  useEffect(() => {
    void api.githubAccount().then(setA, () => setA(null));
  }, []);
  if (a === undefined) return <p className="py-4 text-[12.5px] text-ink-3">Checking your GitHub login…</p>;
  if (a === null) return <p className="py-4 text-[12.5px] text-ink-3">This repo has no GitHub remote.</p>;
  const via = a.source === "nit" ? "with the token saved in nit" : "through the GitHub CLI";
  return (
    <Group>
      <Row
        title="Account"
        hint={
          a.login ? (
            `Signed in as ${a.login} on ${a.host}, ${via}.`
          ) : a.source ? (
            `GitHub didn't accept the token ${via}.`
          ) : (
            <>
              Not signed in. Run <code className="font-mono">gh auth login</code> in a terminal, or save a token below.
            </>
          )
        }
      >
        <Button tone="secondary" onClick={() => void api.githubAccount().then(setA, () => {})}>
          Check again
        </Button>
      </Row>
      <Row
        title="Token"
        hint={`Optional, for ${a.host}: kept in your keychain, and used instead of the GitHub CLI's login. It needs access to the repo's pull requests.`}
      >
        <KeyField
          label="GitHub token"
          placeholder="github_pat_…"
          saved={a.saved}
          store={async (token) => {
            const next = await api.saveGitHubToken(token);
            setA(next);
            return next.saved;
          }}
        />
      </Row>
    </Group>
  );
}

function Linear() {
  const [hasKey, setHasKey] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    void api.linearKey().then(
      (r) => setHasKey(r.hasKey),
      () => setHasKey(false),
    );
  }, []);
  return (
    <Group>
      <Row
        title="API key"
        hint="Optional: with a personal API key (Linear → Settings → Security & access), the issue a branch is for shows with its pull request. Kept in your keychain."
      >
        <KeyField
          label="Linear API key"
          placeholder="lin_api_…"
          saved={!!hasKey}
          store={async (key) => {
            const r = await api.saveLinearKey(key);
            setHasKey(r.hasKey);
            void st.loadGitHub();
            return r.hasKey;
          }}
        />
      </Row>
    </Group>
  );
}

/** A command, saved to your config file when you leave the field or press Enter. */
function CommandField({
  name,
  setting,
  placeholder,
  editable,
  onSaved,
}: {
  name: "checkout" | "editor";
  setting: CommandSetting;
  placeholder: string;
  editable: boolean;
  onSaved: (s: CommandSettings) => void;
}) {
  const [text, setText] = useState(setting.yours ?? "");
  const [state, setState] = useState<{ saved?: boolean; error?: string }>({});
  const save = async () => {
    if (text.trim() === (setting.yours ?? "")) return;
    try {
      onSaved(await api.saveCommands({ [name]: text.trim() || null }));
      setState({ saved: true });
    } catch (e) {
      setState({ error: e instanceof Error ? e.message : "Couldn't save." });
    }
  };
  // A repo's file or an environment variable can win over yours here; say which.
  const overridden = setting.effective && setting.effective.run !== (setting.yours ?? "") ? setting.effective : null;
  return (
    <div className="w-[300px]">
      <input
        value={text}
        disabled={!editable}
        onChange={(e) => {
          setText(e.target.value);
          setState({});
        }}
        onBlur={save}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        aria-label={`${name} command`}
        className="h-7 w-full rounded-control bg-field px-2.5 font-mono text-[12px] text-ink shadow-[inset_0_0_0_1px_var(--line)] outline-none placeholder:text-ink-3 focus:shadow-[inset_0_0_0_1px_var(--accent),0_0_0_3px_var(--accent-tint)] disabled:opacity-60"
      />
      <div className="mt-1 h-4 truncate text-[11.5px] text-ink-3">
        {state.error ? (
          <span className="text-red">{state.error}</span>
        ) : state.saved ? (
          <span className="text-green">Saved</span>
        ) : overridden ? (
          <span title={overridden.run}>
            In this repo: <code className="font-mono">{overridden.run}</code> from {overridden.from}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function Commands() {
  const [s, setS] = useState<CommandSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void api.commands().then(setS, (e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  if (error) return <p className="py-4 text-[12.5px] text-red">{error}</p>;
  if (!s) return <p className="py-4 text-[12.5px] text-ink-3">Reading your config…</p>;
  return (
    <>
      <p className="pb-2 text-[12px] leading-[17px] text-ink-3">
        Saved to <code className="font-mono text-ink-2">{s.file}</code>, for every repo. A repo's{" "}
        <code className="font-mono">.nit.toml</code> or your <code className="font-mono">.nit.local.toml</code> can
        override them there.
        {s.editable ? null : (
          <span className="text-orange"> That file has more than [commands] in it, so edit it by hand.</span>
        )}
      </p>
      <Group>
        <Row
          title="Editor"
          hint={
            <>
              Opens a file at a line (o). <code className="font-mono">{"{file}"}</code> and{" "}
              <code className="font-mono">{"{line}"}</code> are filled in. Empty uses VS Code, else your OS.
            </>
          }
        >
          <CommandField
            name="editor"
            setting={s.editor}
            placeholder="zed {file}:{line}"
            editable={s.editable}
            onSaved={setS}
          />
        </Row>
        <Row
          title="Checkout"
          hint={
            <>
              Checks out a pull request you review by URL: gets <code className="font-mono">$NIT_PR</code> and{" "}
              <code className="font-mono">$NIT_BRANCH</code>, prints the directory. Empty uses a git worktree.
            </>
          }
        >
          <CommandField
            name="checkout"
            setting={s.checkout}
            placeholder="crbn checkout $NIT_PR"
            editable={s.editable}
            onSaved={setS}
          />
        </Row>
      </Group>
    </>
  );
}

// ---------- the screen

const SECTIONS = [
  {
    id: "appearance",
    group: "General",
    label: "Appearance",
    icon: <ColorFilter />,
    body: Appearance,
    about: "How nit and its code look.",
  },
  {
    id: "diff",
    group: "General",
    label: "Diff",
    icon: <GitCompare />,
    body: Diff,
    about: "How changes are laid out and marked.",
  },
  {
    id: "commands",
    group: "General",
    label: "Commands",
    icon: <Code />,
    body: Commands,
    about: "Your editor, and how pull requests are checked out.",
  },
  {
    id: "reviewer",
    group: "AI",
    label: "Reviewer",
    icon: <Sparks />,
    body: Reviewer,
    about: "Who answers your questions, suggests a reading order and co-reviews. Only when you ask.",
  },
  {
    id: "github",
    group: "Accounts",
    label: "GitHub",
    icon: <GitHubIcon />,
    body: GitHub,
    about: "For pull requests: their threads, checks and posting your review.",
  },
  {
    id: "linear",
    group: "Accounts",
    label: "Linear",
    icon: <Page />,
    body: Linear,
    about: "The issue a branch is for, shown with its pull request.",
  },
] as const;
type SectionId = (typeof SECTIONS)[number]["id"];

/** The gear in the sidebar footer; ⌘, works from anywhere. */
export function SettingsButton() {
  return (
    <IconButton label="Settings" keys="Mod+," side="top" onClick={() => st.set({ settingsOpen: true })}>
      <SettingsIcon />
    </IconButton>
  );
}

/** Settings: every change applies at once and is saved for every review. */
export function SettingsDialog() {
  const open = st.useStore((s) => s.settingsOpen);
  const section = st.useStore((s) => s.settingsSection);
  const setSection = (settingsSection: SectionId) => st.set({ settingsSection });
  const current = SECTIONS.find((x) => x.id === section) ?? SECTIONS[0];
  const Body = current.body;
  return (
    <Dialog.Root open={open} onOpenChange={(o) => st.set({ settingsOpen: o })}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-[oklch(0_0_0/0.28)] transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Popup className="fixed top-1/2 left-1/2 z-50 flex h-[min(600px,calc(100vh-48px))] w-[min(820px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-window bg-surface shadow-overlay outline-none transition-[opacity,scale] duration-150 ease-out-strong data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0">
          <nav
            aria-label="Settings sections"
            className="flex w-[184px] shrink-0 flex-col gap-0.5 bg-inset p-2 shadow-[1px_0_0_var(--line)]"
          >
            <Dialog.Title className="flex h-9 items-center px-2 text-[13px] font-medium text-ink">
              Settings
            </Dialog.Title>
            {SECTIONS.map((x, i) => (
              <Fragment key={x.id}>
                {x.group !== SECTIONS[i - 1]?.group ? (
                  <span className="mt-3 mb-0.5 px-2 text-[11px] font-medium text-ink-3 first:mt-0">{x.group}</span>
                ) : null}
                <button
                  key={x.id}
                  type="button"
                  aria-current={x.id === section ? "page" : undefined}
                  onClick={() => setSection(x.id)}
                  className={`flex h-7 items-center gap-2 rounded-control px-2 text-left text-[12.5px] transition-[background-color,color] duration-100 [&_svg]:size-[14px] ${
                    x.id === section
                      ? "bg-hover-2 text-ink"
                      : "text-ink-2 [@media(hover:hover)]:hover:bg-hover [@media(hover:hover)]:hover:text-ink"
                  }`}
                >
                  {x.icon}
                  {x.label}
                </button>
              </Fragment>
            ))}
            <span className="mt-auto px-2 pb-1 text-[11.5px] leading-4 text-ink-3">Changes save as you make them.</span>
          </nav>
          <section className="flex min-w-0 flex-1 flex-col">
            <header className="flex shrink-0 items-start gap-2 px-6 pt-4 pb-3">
              <div className="min-w-0">
                <h2 className="text-[15px] font-semibold text-ink">{current.label}</h2>
                <p className="mt-0.5 text-[12.5px] text-ink-3">{current.about}</p>
              </div>
              <span className="ml-auto flex items-center gap-1">
                <Kbd k="Esc" quiet />
                <Dialog.Close
                  render={
                    <IconButton label="Close" keys="Esc">
                      <Xmark />
                    </IconButton>
                  }
                />
              </span>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
              <Body />
            </div>
          </section>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

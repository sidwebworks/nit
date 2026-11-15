import { Dialog } from "@base-ui/react/dialog";
import { Select } from "@base-ui/react/select";
import type { ColorMode, ColorScheme } from "@pierre/theming";
import { useQuery } from "@tanstack/react-query";
import {
  Check,
  Code,
  ColorFilter,
  GitCompare,
  Github as GitHubIcon,
  NavArrowDown,
  Page,
  Refresh,
  Settings as SettingsIcon,
  Sparks,
  Xmark,
} from "iconoir-react/regular";
import { Fragment, type ReactNode, useEffect, useState } from "react";
import type { AuthStatus, CommandSetting, CommandSettings, Prefs } from "../types";
import { api } from "./api";
import {
  claudeAuthQuery,
  codexAuthQuery,
  commandsQuery,
  githubAccountQuery,
  linearKeyQuery,
  queryClient,
} from "./query";
import * as st from "./state";
import { catalog, nameFor, switchTheme, theme, useTheme } from "./theme";
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
function Row({ title, hint, keys, children }: { title: string; hint?: ReactNode; keys?: string; children: ReactNode }) {
  return (
    <div className="flex min-h-12 items-center gap-6 px-4 py-2 shadow-[0_1px_0_var(--line-soft)] last:shadow-none">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-[13px] text-ink">
          {title}
          {keys ? <Kbd k={keys} quiet /> : null}
        </div>
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
    <Group>
      <Row title="Mode">
        <TextSegmented
          label="Colour mode"
          value={t.mode}
          onChange={(m) => void switchTheme(() => theme.setColorMode(m))}
          options={MODES}
        />
      </Row>
      <Row title="Light theme">
        <Choice
          label="Light theme"
          value={nameFor(t, "light")}
          options={themeOptions("light")}
          onChange={(v) => void switchTheme(() => theme.setThemeNameForScheme("light", v), v)}
        />
      </Row>
      <Row title="Dark theme">
        <Choice
          label="Dark theme"
          value={nameFor(t, "dark")}
          options={themeOptions("dark")}
          onChange={(v) => void switchTheme(() => theme.setThemeNameForScheme("dark", v), v)}
        />
      </Row>
      <Row title="Code size">
        <Stepper value={size} min={11} max={16} step={0.5} onChange={(fontSize) => st.setPrefs({ fontSize })} />
      </Row>
    </Group>
  );
}

function Diff() {
  const style = st.useStore((s) => s.style);
  const p = st.useStore((s) => s.prefs);
  return (
    <Group>
      <Row title="Layout" keys="s">
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
      <Row title="Wrap long lines">
        <Switch label="Wrap long lines" on={p.wrap} onChange={(wrap) => st.setPrefs({ wrap })} />
      </Row>
      <Row title="Line markers">
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
      <Row title="Inline changes">
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

/** A sign-in status: a dot and a few words, with a refresh. */
function Status({ status, onCheck }: { status: { tone: string; text: string }; onCheck: () => void }) {
  return (
    <span className="flex items-center gap-2 text-[12.5px] text-ink-2">
      <span className={`size-1.5 rounded-full ${status.tone}`} />
      {status.text}
      <IconButton label="Check again" onClick={onCheck}>
        <Refresh />
      </IconButton>
    </span>
  );
}

const cmd = (text: string) => <code className="font-mono text-ink-2">{text}</code>;

/**
 * Who reads the code with you: Claude Code or Codex. Each runs the one you installed, on your
 * own sign-in or an API key saved in your keychain.
 */
function Reviewer() {
  const p = st.useStore((s) => s.prefs);
  const claudeQ = useQuery(claudeAuthQuery);
  const codexQ = useQuery(codexAuthQuery);
  const claude: Status = claudeQ.data ?? null;
  const codex: Status = codexQ.data ?? null;
  const check = () => {
    void claudeQ.refetch();
    void codexQ.refetch();
  };
  const claudeStatus = statusOf("Claude Code", claude, p.auth === "apiKey");
  const codexStatus = statusOf("Codex", codex, p.codexAuth === "apiKey");
  return (
    <>
      <Group>
        <Row title="Provider">
          <TextSegmented<Prefs["reviewer"]>
            label="AI provider"
            value={p.reviewer}
            onChange={(reviewer) => st.setPrefs({ reviewer })}
            options={[
              { value: "claude", label: "Claude Code" },
              { value: "codex", label: "Codex" },
            ]}
          />
        </Row>
      </Group>

      {p.reviewer === "claude" ? (
        <Group title="Claude Code">
          <Row title="Sign in with">
            <TextSegmented<Prefs["auth"]>
              label="Claude sign in"
              value={p.auth}
              onChange={(a) => st.setPrefs({ auth: a })}
              options={[
                { value: "login", label: "Account" },
                { value: "apiKey", label: "API key" },
              ]}
            />
          </Row>
          {p.auth === "login" ? (
            <Row
              title="Account"
              hint={
                claude && !claude.installed ? (
                  <>Install Claude Code, then sign in.</>
                ) : claude && !claude.loggedIn ? (
                  <>
                    Run {cmd("claude")}, then {cmd("/login")}
                  </>
                ) : undefined
              }
            >
              <Status status={claudeStatus} onCheck={check} />
            </Row>
          ) : (
            <Row title="API key">
              <KeyField
                label="Anthropic API key"
                placeholder="sk-ant-…"
                missing="No key saved"
                saved={!!claude?.hasKey}
                store={async (key) => {
                  const { hasKey } = await api.saveClaudeKey(key);
                  queryClient.setQueryData(claudeAuthQuery.queryKey, (a) => (a ? { ...a, hasKey } : a));
                  return hasKey;
                }}
              />
            </Row>
          )}
          <Row title="Model">
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
          <Row title="Effort">
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
        <Group title="Codex" note="Applying comments still uses Claude Code.">
          <Row title="Sign in with">
            <TextSegmented<Prefs["codexAuth"]>
              label="Codex sign in"
              value={p.codexAuth}
              onChange={(codexAuth) => st.setPrefs({ codexAuth })}
              options={[
                { value: "login", label: "ChatGPT" },
                { value: "apiKey", label: "API key" },
              ]}
            />
          </Row>
          {p.codexAuth === "login" ? (
            <Row
              title="Account"
              hint={
                codex && !codex.installed ? (
                  <>Install it: {cmd("brew install codex")}</>
                ) : codex && !codex.loggedIn ? (
                  <>Run {cmd("codex login")}</>
                ) : undefined
              }
            >
              <Status status={codexStatus} onCheck={check} />
            </Row>
          ) : (
            <Row title="API key">
              <KeyField
                label="OpenAI API key"
                placeholder="sk-…"
                missing="No key saved"
                saved={!!codex?.hasKey}
                store={async (key) => {
                  const { hasKey } = await api.saveCodexKey(key);
                  queryClient.setQueryData(codexAuthQuery.queryKey, (a) => (a ? { ...a, hasKey } : a));
                  return hasKey;
                }}
              />
            </Row>
          )}
          <Row title="Model">
            <TextField
              label="Codex model"
              value={p.codexModel}
              placeholder="Default"
              onSave={(codexModel) => st.setPrefs({ codexModel })}
            />
          </Row>
          <Row title="Reasoning">
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

      <Group>
        <Row title="Nitpicks in co-review">
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
  const [state, setState] = useState<{ error?: string }>({});
  const save = async (key: string | null) => {
    try {
      const has = await store(key);
      setText("");
      setState({});
      st.toast(has ? "Saved to your keychain" : "Key removed");
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
      {state.error || (!saved && missing) ? (
        <div className={`mt-1 truncate text-[11.5px] ${state.error ? "text-red" : "text-orange"}`}>
          {state.error ?? missing}
        </div>
      ) : null}
    </div>
  );
}

function GitHub() {
  const q = useQuery(githubAccountQuery);
  // No answer means no GitHub remote: the server only fails this when there's no repo to ask about.
  const a = q.isError ? null : q.data;
  if (a === undefined) return <p className="py-4 text-[12.5px] text-ink-3">Checking your GitHub login…</p>;
  if (a === null) return <p className="py-4 text-[12.5px] text-ink-3">This repo has no GitHub remote.</p>;
  const via = a.source === "nit" ? "token" : "GitHub CLI";
  const status = a.login
    ? { tone: "bg-green", text: `${a.login} · ${via}` }
    : a.source
      ? { tone: "bg-red", text: `The ${via} login was refused` }
      : { tone: "bg-orange", text: "Not signed in" };
  return (
    <Group>
      <Row title="Account" hint={a.login ? undefined : <>Run {cmd("gh auth login")}, or add a token</>}>
        <Status status={status} onCheck={() => void q.refetch()} />
      </Row>
      <Row title="Token" hint={a.saved ? undefined : "Optional · used instead of the CLI login"}>
        <KeyField
          label="GitHub token"
          placeholder="github_pat_…"
          saved={a.saved}
          store={async (token) => {
            const next = await api.saveGitHubToken(token);
            queryClient.setQueryData(githubAccountQuery.queryKey, next);
            return next.saved;
          }}
        />
      </Row>
    </Group>
  );
}

function Linear() {
  const hasKey = useQuery(linearKeyQuery).data?.hasKey;
  return (
    <Group>
      <Row title="API key" hint="Shows a branch's issue with its pull request">
        <KeyField
          label="Linear API key"
          placeholder="lin_api_…"
          saved={!!hasKey}
          store={async (key) => {
            const r = await api.saveLinearKey(key);
            queryClient.setQueryData(linearKeyQuery.queryKey, r);
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
  const [state, setState] = useState<{ error?: string }>({});
  const save = async () => {
    if (text.trim() === (setting.yours ?? "")) return;
    try {
      onSaved(await api.saveCommands({ [name]: text.trim() || null }));
      setState({});
      st.toast("Saved");
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
      {state.error ? (
        <div className="mt-1 truncate text-[11.5px] text-red">{state.error}</div>
      ) : overridden ? (
        <div className="mt-1 truncate text-[11.5px] text-ink-3" title={overridden.run}>
          This repo uses <code className="font-mono">{overridden.run}</code> ({overridden.from})
        </div>
      ) : null}
    </div>
  );
}

function Commands() {
  const q = useQuery(commandsQuery);
  const s = q.data;
  const saved = (next: CommandSettings) => queryClient.setQueryData(commandsQuery.queryKey, next);
  if (q.error) return <p className="py-4 text-[12.5px] text-red">{q.error.message}</p>;
  if (!s) return <p className="py-4 text-[12.5px] text-ink-3">Reading your config…</p>;
  return (
    <Group
      note={
        s.editable ? (
          <>Saved to {cmd(s.file)}</>
        ) : (
          <span className="text-orange">{cmd(s.file)} has more than [commands] in it: edit it by hand</span>
        )
      }
    >
      <Row title="Editor" keys="o">
        <CommandField
          name="editor"
          setting={s.editor}
          placeholder="zed {file}:{line}"
          editable={s.editable}
          onSaved={saved}
        />
      </Row>
      <Row title="Checkout">
        <CommandField
          name="checkout"
          setting={s.checkout}
          placeholder="crbn checkout $NIT_PR"
          editable={s.editable}
          onSaved={saved}
        />
      </Row>
    </Group>
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
  },
  {
    id: "diff",
    group: "General",
    label: "Diff",
    icon: <GitCompare />,
    body: Diff,
  },
  {
    id: "commands",
    group: "General",
    label: "Commands",
    icon: <Code />,
    body: Commands,
  },
  {
    id: "reviewer",
    group: "General",
    label: "AI",
    icon: <Sparks />,
    body: Reviewer,
  },
  {
    id: "github",
    group: "Accounts",
    label: "GitHub",
    icon: <GitHubIcon />,
    body: GitHub,
  },
  {
    id: "linear",
    group: "Accounts",
    label: "Linear",
    icon: <Page />,
    body: Linear,
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
        <Dialog.Popup className="fixed top-1/2 left-1/2 z-50 flex h-[min(540px,calc(100vh-48px))] w-[min(760px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-window bg-surface shadow-overlay outline-none transition-[opacity,scale] duration-150 ease-out-strong data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0">
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
          </nav>
          <section className="flex min-w-0 flex-1 flex-col">
            <header className="flex h-13 shrink-0 items-center gap-2 px-6">
              <h2 className="text-[15px] font-semibold text-ink">{current.label}</h2>
              <span className="ml-auto flex items-center gap-1">
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

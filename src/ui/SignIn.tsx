import { Dialog } from "@base-ui/react/dialog";
import { useQuery } from "@tanstack/react-query";
import { Copy, Sparks } from "iconoir-react/regular";
import { useEffect } from "react";
import { copy } from "./Menu";
import { claudeAuthQuery } from "./query";
import * as st from "./state";
import { Button, IconButton } from "./ui";

/** Says Claude needs signing in; `retry` runs again once it is. */
export function needSignIn(retry: (() => void) | null) {
  st.set({ signIn: { retry } });
}

export function SignInDialog() {
  const open = st.useStore((s) => s.signIn);
  if (!open) return null;
  return <SignIn retry={open.retry} />;
}

/**
 * Claude Code's login expired (or never happened). nit doesn't sign you in itself: you sign in to
 * Claude Code the usual way, and this notices when you have and carries on. Or use an API key.
 */
function SignIn({ retry }: { retry: (() => void) | null }) {
  // Watch for the login to land; a terminal sign-in takes a minute, so every two seconds is plenty.
  const loggedIn = useQuery({ ...claudeAuthQuery, refetchInterval: 2000 }).data?.loggedIn;
  useEffect(() => {
    if (!loggedIn) return;
    st.set({ signIn: null });
    st.notify("Signed in to Claude");
    retry?.();
  }, [loggedIn, retry]);

  const close = () => st.set({ signIn: null });
  const useKey = () => st.set({ signIn: null, settingsOpen: true, settingsSection: "reviewer" });

  return (
    <Dialog.Root open onOpenChange={(o) => !o && close()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-[oklch(0_0_0/0.28)] transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Popup className="fixed top-[22vh] left-1/2 z-50 w-[min(440px,calc(100vw-32px))] -translate-x-1/2 rounded-window bg-surface p-5 shadow-overlay outline-none transition-[opacity,scale] duration-150 ease-out-strong data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0">
          <div className="mb-3 flex size-8 items-center justify-center rounded-control bg-accent-tint text-accent-ink">
            <Sparks width={16} height={16} />
          </div>
          <Dialog.Title className="text-[15px] font-semibold text-ink">Claude needs signing in</Dialog.Title>
          <Dialog.Description className="mt-1.5 text-[13px] text-ink-2">
            nit runs Claude with Claude Code's login, and it has expired. Sign in to Claude Code
            {retry ? " and nit picks up where you left off." : "."}
          </Dialog.Description>

          <ol className="mt-4 space-y-2 rounded-card bg-inset p-3 text-[12.5px] text-ink-2 shadow-[inset_0_0_0_1px_var(--line)]">
            <li className="flex items-center gap-2">
              <span className="w-4 shrink-0 text-ink-3 tabular-nums">1</span>
              In a terminal, run
              <code className="rounded-[5px] bg-field px-1.5 py-0.5 font-mono text-[12px] text-ink shadow-[inset_0_0_0_1px_var(--line)]">
                claude
              </code>
              <IconButton label="Copy the command" onClick={() => copy("claude", "the command")}>
                <Copy />
              </IconButton>
            </li>
            <li className="flex items-center gap-2">
              <span className="w-4 shrink-0 text-ink-3 tabular-nums">2</span>
              Type
              <code className="rounded-[5px] bg-field px-1.5 py-0.5 font-mono text-[12px] text-ink shadow-[inset_0_0_0_1px_var(--line)]">
                /login
              </code>
              and finish in your browser.
            </li>
          </ol>

          <p className="mt-3 flex items-center gap-2 text-[12px] text-ink-3">
            <span className="size-3 shrink-0 animate-spin rounded-full border-[1.5px] border-line-strong border-t-accent" />
            Waiting for Claude Code's login…
          </p>

          <div className="mt-5 flex items-center gap-2">
            <Button tone="ghost" onClick={useKey}>
              Use an API key instead
            </Button>
            <Button tone="secondary" className="ml-auto" onClick={close}>
              Not now
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

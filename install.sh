#!/bin/sh
# Installs nit, the single binary, from its latest GitHub release:
#
#   curl -fsSL https://raw.githubusercontent.com/sidwebworks/nit/main/install.sh | sh
#
# NIT_VERSION=v0.1.0 picks a release; NIT_INSTALL_DIR picks where it goes (default ~/.local/bin).
set -eu

repo="sidwebworks/nit"
dir="${NIT_INSTALL_DIR:-$HOME/.local/bin}"

say() { printf '%s\n' "$*"; }
die() { printf 'nit: %s\n' "$*" >&2; exit 1; }

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) die "no build for $(uname -s) yet" ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) die "no build for $(uname -m) yet" ;;
esac
# An x64 shell under Rosetta still gets the native build.
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
  arch=arm64
fi

asset="nit-$os-$arch.tar.gz"
if [ -n "${NIT_VERSION:-}" ]; then
  url="https://github.com/$repo/releases/download/$NIT_VERSION/$asset"
else
  url="https://github.com/$repo/releases/latest/download/$asset"
fi

command -v curl >/dev/null || die "needs curl"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

say "Downloading $asset"
# A progress bar when someone's watching (curl draws it on stderr); quiet in CI and logs.
if [ -t 2 ]; then progress=--progress-bar; else progress=-s; fi
curl -fSL "$progress" "$url" -o "$tmp/$asset" || die "couldn't download $url"
curl -fsSL "$url.sha256" -o "$tmp/$asset.sha256" || die "couldn't download the checksum"

# The .sha256 file is "<hash>  <name>", made by shasum -a 256.
want="$(cut -d ' ' -f 1 <"$tmp/$asset.sha256")"
if command -v shasum >/dev/null; then
  got="$(shasum -a 256 "$tmp/$asset" | cut -d ' ' -f 1)"
else
  got="$(sha256sum "$tmp/$asset" | cut -d ' ' -f 1)"
fi
[ "$want" = "$got" ] || die "checksum mismatch: expected $want, got $got"

tar -xzf "$tmp/$asset" -C "$tmp"
mkdir -p "$dir"
mv "$tmp/nit" "$dir/nit"
chmod +x "$dir/nit"
say "Installed nit $("$dir/nit" --version) to $dir/nit"

case ":$PATH:" in
  *":$dir:"*) ;;
  *) say "" && say "$dir isn't on your PATH. Add this to your shell's profile:" && say "  export PATH=\"$dir:\$PATH\"" ;;
esac
if ! command -v claude >/dev/null && ! command -v codex >/dev/null; then
  say "" && say "AI features need Claude Code (https://claude.com/claude-code) or Codex."
fi
say "" && say "Run nit inside a git repository."

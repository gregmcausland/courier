#!/usr/bin/env bash
#
# Build Courier and install it on the current user's PATH.
#
# Usage:
#   ./install.sh                 # install to ~/.local/bin (or $COURIER_BIN_DIR)
#   COURIER_BIN_DIR=~/bin ./install.sh
#
# Installs a symlink named `courier` pointing at this repo's compiled CLI, so
# rebuilding the repo (npm run build) transparently updates the installed command.
# User-scoped: never needs sudo.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${COURIER_BIN_DIR:-$HOME/.local/bin}"
CLI="$REPO_DIR/dist/cli.js"
LINK="$BIN_DIR/courier"
SKILL_SRC="$REPO_DIR/skills/courier"

say() { printf '\033[1;34m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$1" >&2; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$1" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "node is required but was not found on PATH"
command -v npm  >/dev/null 2>&1 || die "npm is required but was not found on PATH"

say "Installing dependencies"
npm --prefix "$REPO_DIR" install

say "Building Courier"
npm --prefix "$REPO_DIR" run build

[ -f "$CLI" ] || die "build did not produce $CLI"
chmod +x "$CLI"

say "Linking $LINK -> $CLI"
mkdir -p "$BIN_DIR"
if [ -e "$LINK" ] && [ ! -L "$LINK" ]; then
  die "$LINK already exists and is not a symlink; remove it or set COURIER_BIN_DIR"
fi
ln -sf "$CLI" "$LINK"

# Sanity check: run through the freshly installed command.
if ! "$LINK" --help >/dev/null 2>&1; then
  die "installed courier failed to run ($LINK --help)"
fi

say "Installed courier $("$LINK" --help >/dev/null 2>&1 && node -p "require('$REPO_DIR/package.json').version")"

# Link the human-invoked `courier` skill into the harness skill dirs. The skill
# carries `disable-model-invocation: true`, so it stays out of every agent's
# auto-discovery and only loads when a human types /courier (or /skill:courier
# in pi). ~/.agents/skills is read natively by pi and cursor-agent; ~/.claude/
# skills is read by Claude Code. Set COURIER_NO_SKILL=1 to skip.
link_skill() {
  local dest="$1"
  local link="$dest/courier"
  mkdir -p "$dest"
  if [ -e "$link" ] && [ ! -L "$link" ]; then
    warn "$link exists and is not a symlink; leaving it untouched"
    return
  fi
  ln -sfn "$SKILL_SRC" "$link"
  say "Linked skill $link -> $SKILL_SRC"
}

if [ "${COURIER_NO_SKILL:-}" != "1" ]; then
  [ -f "$SKILL_SRC/SKILL.md" ] || die "missing skill source $SKILL_SRC/SKILL.md"
  link_skill "$HOME/.agents/skills"
  link_skill "$HOME/.claude/skills"
  say "Skill ready. Invoke with /courier (Claude Code, cursor-agent) or /skill:courier (pi)."
fi

case ":$PATH:" in
  *":$BIN_DIR:"*)
    say "Done. Try: courier --help"
    ;;
  *)
    warn "$BIN_DIR is not on your PATH."
    printf '  Add this to your shell profile (e.g. ~/.zshrc, ~/.bashrc):\n\n    export PATH="%s:$PATH"\n\n  Then restart your shell and run: courier --help\n' "$BIN_DIR"
    ;;
esac

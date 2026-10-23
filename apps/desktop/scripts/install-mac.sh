#!/bin/bash
# Installs (or updates) Recast on a Mac from the file downloaded from GitHub, and opens it. Paste into Terminal:
#   curl -fsSL https://raw.githubusercontent.com/shishirbhat/Recast/claude/clever-heisenberg-s3taqj/apps/desktop/scripts/install-mac.sh | bash
#
# It uses the newest Recast download in ~/Downloads (the .dmg, or the .zip GitHub wraps it in, or the app's .zip), or
# the file given as the first argument. In order: checks the disk image is whole, quits any Recast already running (an
# old copy would otherwise take over the new one's launch and show nothing), replaces /Applications/Recast.app, clears
# the "downloaded from the internet" mark that makes macOS refuse an app without an Apple Developer ID, and opens it.
# It downloads nothing and installs nothing else. RECAST_NO_OPEN=1 installs without opening (CI).
set -euo pipefail

APP="/Applications/Recast.app"
case "$(uname -m)" in arm64) ARCH=arm64 ;; x86_64) ARCH=x64 ;; *) echo "Recast: unsupported Mac ($(uname -m))" >&2; exit 1 ;; esac
say() { printf '\033[1mRecast:\033[0m %s\n' "$1"; }
fail() { say "$1" >&2; exit 1; }

src="${1:-}"
if [ -z "$src" ]; then
  # Newest first; this Mac's kind only (an Intel build would run slowly through Rosetta, an Apple silicon one not at all).
  src="$(ls -t "$HOME"/Downloads/Recast*"$ARCH"*.dmg "$HOME"/Downloads/Recast*"$ARCH"*.zip \
           "$HOME"/Downloads/Recast-for-Mac-$( [ "$ARCH" = arm64 ] && echo Apple-silicon || echo Intel )*.zip 2>/dev/null | head -1 || true)"
  if [ -z "$src" ] && [ -d "$APP" ]; then src="installed"
  else [ -n "$src" ] || fail "no Recast download for this Mac in Downloads. Download it from GitHub first (Recast-for-Mac-$( [ "$ARCH" = arm64 ] && echo Apple-silicon || echo Intel ))."; fi
fi
if [ "$src" = "installed" ]; then
  # Already dragged into Applications: only unblock and open it (below).
  say "no download in Downloads; unblocking the Recast already in Applications"
else
  [ -f "$src" ] || fail "$src is not a file"
  say "using $src"
fi

work="$(mktemp -d)"; mnt="$work/mnt"
cleanup() { hdiutil detach "$mnt" -quiet 2>/dev/null || true; rm -rf "$work"; }
trap cleanup EXIT

# A .zip holds either the app itself or the disk image (GitHub's download wrapper).
[ "$src" = "installed" ] && app="$APP"
if [[ "$src" == *.zip ]]; then
  ditto -x -k "$src" "$work/unzipped" || fail "the .zip is incomplete or damaged. Download it again."
  app="$(find "$work/unzipped" -maxdepth 2 -name Recast.app -type d | head -1)"
  [ -n "$app" ] || src="$(find "$work/unzipped" -maxdepth 2 -name '*.dmg' | head -1)"
  [ -n "$app" ] || [ -n "$src" ] || fail "the .zip has neither Recast.app nor a disk image in it."
fi
if [ -z "${app:-}" ]; then
  hdiutil verify -quiet "$src" || fail "the disk image is incomplete or damaged. Download it again."
  if hdiutil attach "$src" -nobrowse -readonly -quiet -mountpoint "$mnt"; then app="$mnt/Recast.app"
  else app="$(ls -d /Volumes/Recast*/Recast.app 2>/dev/null | head -1 || true)"; fi   # Safari may have opened it already
  [ -n "$app" ] && [ -d "$app" ] || fail "the disk image would not open. Eject any \"Recast\" disk in Finder and run this again."
fi

# Quit any Recast already running, old builds included (they may have no window and no Dock icon).
if pgrep -xq recast || pgrep -xq Recast; then
  say "closing the Recast that is already running…"
  osascript -e 'tell application id "dev.recast.desktop" to quit' >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do (pgrep -xq recast || pgrep -xq Recast) || break; sleep 0.5; done
  pkill -x recast 2>/dev/null || true; pkill -x Recast 2>/dev/null || true; sleep 1
fi

if [ "$app" != "$APP" ]; then
  say "installing into Applications…"
  if [ -w /Applications ]; then rm -rf "$APP"; ditto "$app" "$APP"
  else sudo rm -rf "$APP"; sudo ditto "$app" "$APP"; fi
fi
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || sudo xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true

if [ -z "${RECAST_NO_OPEN:-}" ]; then open "$APP"; say "Recast is open. It is in Applications and in the Dock."; else say "installed."; fi
say "select text in any app and press ⌘⇧Space to grab it; ⌃⌥Space opens or hides Recast."

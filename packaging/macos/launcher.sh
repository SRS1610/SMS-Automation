#!/bin/bash
# SMS Automation for macOS.
#
# Double-clicking the app runs this script. It starts the local server in the
# background (unless it is already running) and opens the dashboard in the
# default browser. The server keeps sending while the browser is closed; use
# "Quit app" in the dashboard's sidebar to stop it.
set -u

APP_NAME="SMS Automation"
PORT="${SMS_AUTOMATION_PORT:-47821}"
URL="http://127.0.0.1:${PORT}"
CONTENTS="$(cd "$(dirname "$0")/.." && pwd)"
RES="$CONTENTS/Resources"
DATA_DIR="$HOME/Library/Application Support/$APP_NAME"
LOG_DIR="$HOME/Library/Logs/$APP_NAME"
LOG="$LOG_DIR/server.log"

alert() {
  /usr/bin/osascript - "$1" >/dev/null 2>&1 <<'APPLESCRIPT'
on run argv
  display alert "SMS Automation" message (item 1 of argv) as critical
end run
APPLESCRIPT
}

# True when our own server answers on the port (another program might use it).
running() {
  /usr/bin/curl -fsS -m 2 "$URL/api/session" 2>/dev/null | /usr/bin/grep -q '"desktop":true'
}

if running; then
  /usr/bin/open "$URL"
  exit 0
fi

case "$CONTENTS" in
  /Volumes/*)
    alert "Drag SMS Automation into your Applications folder first, then open it from there."
    exit 1
    ;;
esac

if [ "$(/usr/sbin/sysctl -n hw.optional.arm64 2>/dev/null)" = "1" ]; then ARCH=arm64; else ARCH=x64; fi
NODE="$RES/runtime/darwin-$ARCH/node"
if [ ! -x "$NODE" ]; then
  alert "This copy of the app has no runtime for this Mac ($ARCH). Please download it again."
  exit 1
fi

# You approved the app when you opened it; also clear the download flag on the
# bundled runtime so macOS lets the app start it.
/usr/bin/xattr -d com.apple.quarantine "$NODE" 2>/dev/null || true

mkdir -p "$DATA_DIR" "$LOG_DIR"
if [ -f "$LOG" ] && [ "$(/usr/bin/stat -f%z "$LOG")" -gt 5000000 ]; then
  mv -f "$LOG" "$LOG.1"
fi
cd "$DATA_DIR" || exit 1

export DESKTOP_MODE=1
export HOST=127.0.0.1
export PORT
export DATA_DIR
export WEB_DIR="$RES/web"
export ALLOWED_HOSTS="127.0.0.1:$PORT,localhost:$PORT"

# Start the server in its own session so it keeps running after this script exits.
PID="$("$NODE" "$RES/server/detach.cjs" "$LOG" "$NODE" --disable-warning=ExperimentalWarning "$RES/server/server.cjs")"

for _ in $(seq 1 80); do
  if running; then
    /usr/bin/open "$URL"
    exit 0
  fi
  if [ -n "$PID" ] && ! kill -0 "$PID" 2>/dev/null; then
    break
  fi
  sleep 0.25
done

alert "SMS Automation couldn't start. Details are in ~/Library/Logs/$APP_NAME/server.log"
exit 1

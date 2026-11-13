#!/bin/sh
set -eu
SKILL_HOME=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
OS=$(uname -s); ARCH=$(uname -m)
case "$OS:$ARCH" in
  Darwin:arm64) NODE="$SKILL_HOME/bin/darwin-arm64/node" ;;
  Darwin:x86_64) NODE="$SKILL_HOME/bin/darwin-x64/node" ;;
  *) printf 'Unsupported platform: %s %s\n' "$OS" "$ARCH" >&2; exit 1 ;;
esac
[ -x "$NODE" ] || { printf 'Missing executable Node.js: %s\n' "$NODE" >&2; exit 1; }
PYTHON=$(command -v python3 || command -v python || true)
[ -n "$PYTHON" ] || { echo 'Python 3 is required for saved-password Wi-Fi.' >&2; exit 2; }
"$PYTHON" -c 'import paramiko; print("Paramiko",paramiko.__version__); raise SystemExit(0 if paramiko.__version__.split(".")[0] == "5" else 1)' || { echo 'Python Paramiko 5.x is required. Install with: python3 -m pip install "paramiko>=5,<6". Paramiko is LGPL-2.1 and is not bundled.' >&2; exit 2; }
STATE_DIR="$HOME/Library/Application Support/CocoPi2DeviceManager"
mkdir -p "$STATE_DIR"
KEY_FILE="$STATE_DIR/secret.key"
if [ ! -f "$KEY_FILE" ]; then "$NODE" -e "require('node:fs').writeFileSync(process.argv[1],require('node:crypto').randomBytes(32),{mode:0o600})" "$KEY_FILE"; chmod 600 "$KEY_FILE"; fi
export COCOPI2_SECRET_KEY=$("$NODE" -e "process.stdout.write(require('node:fs').readFileSync(process.argv[1]).toString('base64'))" "$KEY_FILE")
export COCOPI2_SECRET_FILE="$STATE_DIR/ssh-password.json"
export COCOPI2_SSH_HOST_KEY_MODE=accept-new
export COCOPI2_PYTHON="$PYTHON"
export HOST=127.0.0.1 PORT=8787
exec "$NODE" "$SKILL_HOME/scripts/server.js"

#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_DIR="${AEROTRACE_COMPLETION_ENV:-$HOME/aerotrace-completion-env}"

python3 -m venv "$ENV_DIR"
"$ENV_DIR/bin/python" -m pip install --upgrade pip
"$ENV_DIR/bin/python" -m pip install -r "$PROJECT_ROOT/tools/requirements-completion.txt"

mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/aerotrace-complete" <<EOF
#!/usr/bin/env bash
exec "$ENV_DIR/bin/python" "$PROJECT_ROOT/tools/aerotrace-complete" "\$@"
EOF
chmod +x "$HOME/.local/bin/aerotrace-complete"

if ! printf '%s' "$PATH" | tr ':' '\n' | grep -qx "$HOME/.local/bin"; then
  echo "Add this directory to PATH: export PATH=\"\$HOME/.local/bin:\$PATH\""
fi

echo "Completion worker installed. Verify with: $HOME/.local/bin/aerotrace-complete --help"

#!/usr/bin/env bash
set -euo pipefail

INSTALLER="$(dirname "$0")/../install.sh"
INSTALLER="$(realpath "$INSTALLER")"

if [[ ! -f "$INSTALLER" ]]; then
    echo "install.sh not found at $INSTALLER"
    exit 1
fi

# Compute checksum of everything except the SCRIPT_CHECKSUM line
CHECKSUM=$(grep -v '^SCRIPT_CHECKSUM=' "$INSTALLER" | sha256sum | awk '{print $1}')

# Embed it
sed -i "s|^SCRIPT_CHECKSUM=.*|SCRIPT_CHECKSUM=\"$CHECKSUM\"|" "$INSTALLER"

echo "Signed install.sh"
echo "  sha256: $CHECKSUM"
echo ""
echo "Verify with:"
echo "  grep -v '^SCRIPT_CHECKSUM=' install.sh | sha256sum"

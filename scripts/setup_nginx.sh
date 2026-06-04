#!/bin/bash
# ============================================================
#  Setup Nginx reverse proxy for ChaungThai API
#  Run with: sudo bash setup_nginx.sh
#  Run from: anywhere (uses absolute paths)
# ============================================================

set -e  # หยุดทันทีถ้ามี error

SNIPPET_SRC="/tmp/chaungthai-api.conf"
SNIPPET_DST="/etc/nginx/snippets/chaungthai-api.conf"
DEFAULT_CFG="/etc/nginx/sites-available/default"
BACKUP_CFG="/etc/nginx/sites-available/default.bak.$(date +%Y%m%d-%H%M%S)"

echo "=== 1. Backup default config ==="
cp -v "$DEFAULT_CFG" "$BACKUP_CFG"

echo "=== 2. Install snippet ==="
if [ ! -f "$SNIPPET_SRC" ]; then
    echo "ERROR: $SNIPPET_SRC not found - upload first!"
    exit 1
fi
cp -v "$SNIPPET_SRC" "$SNIPPET_DST"
chmod 644 "$SNIPPET_DST"

echo "=== 3. Add include directive to default (if not already there) ==="
if grep -q "snippets/chaungthai-api.conf" "$DEFAULT_CFG"; then
    echo "include already exists - skip"
else
    # เพิ่ม include ก่อน "include snippets/phpmyadmin.conf;"
    sed -i 's|include snippets/phpmyadmin.conf;|include snippets/chaungthai-api.conf;\n    include snippets/phpmyadmin.conf;|' "$DEFAULT_CFG"
    echo "include added"
fi

echo "=== 4. Test nginx config ==="
nginx -t

echo "=== 5. Reload nginx ==="
systemctl reload nginx

echo "=== 6. Test endpoint (curl -k https://localhost/api/health) ==="
curl -k -s https://localhost/api/health

echo ""
echo "=== DONE ==="
echo "Backup saved at: $BACKUP_CFG"

#!/bin/bash
# Copies the site's data from Cloudflare to this droplet (2026-11-12).
# Run as root:  CF_API_TOKEN=<your token> bash /opt/rax/app/server/migrate.sh
# The token is yours alone - make it in Cloudflare (My Profile -> API Tokens)
# with Account / D1 / Read and Account / Workers KV Storage / Read.
set -e
[ -n "$CF_API_TOKEN" ] || { echo "Set CF_API_TOKEN first."; exit 1; }
API=https://api.cloudflare.com/client/v4
H="Authorization: Bearer $CF_API_TOKEN"
export CF_ACCOUNT_ID=$(curl -fsS -H "$H" "$API/accounts" | python3 -c 'import sys,json;r=json.load(sys.stdin)["result"];print(r[0]["id"])')
echo "Account: $CF_ACCOUNT_ID"
DBS=$(curl -fsS -H "$H" "$API/accounts/$CF_ACCOUNT_ID/d1/database" | python3 -c 'import sys,json;print("\n".join(d["name"] for d in json.load(sys.stdin)["result"]))')
echo "D1 databases:"; echo "$DBS"
DB=${CF_D1_NAME:-$(echo "$DBS" | grep -i rateboard | head -1)}; DB=${DB:-$(echo "$DBS" | head -1)}
NSS=$(curl -fsS -H "$H" "$API/accounts/$CF_ACCOUNT_ID/storage/kv/namespaces?per_page=100" | python3 -c 'import sys,json;print("\n".join(n["id"]+" "+n["title"] for n in json.load(sys.stdin)["result"]))')
echo "KV namespaces:"; echo "$NSS"
export CF_KV_ID=${CF_KV_ID:-$(echo "$NSS" | grep -i rateboard | head -1 | cut -d' ' -f1)}; CF_KV_ID=${CF_KV_ID:-$(echo "$NSS" | head -1 | cut -d' ' -f1)}
echo "Using D1 '$DB' and KV $CF_KV_ID"
systemctl stop rax || true
cd /opt/rax/data
rm -f d1.sql
CLOUDFLARE_API_TOKEN=$CF_API_TOKEN CLOUDFLARE_ACCOUNT_ID=$CF_ACCOUNT_ID npx -y wrangler@3 d1 export "$DB" --remote --output /opt/rax/data/d1.sql
rm -f rateboard.db rateboard.db-wal rateboard.db-shm
sqlite3 rateboard.db < d1.sql
sqlite3 rateboard.db 'PRAGMA journal_mode=WAL;' >/dev/null
echo "Database rows per table:"; sqlite3 rateboard.db "SELECT name FROM sqlite_master WHERE type='table'" | while read t; do echo "  $t $(sqlite3 rateboard.db "SELECT COUNT(*) FROM \"$t\"")"; done
rm -f kv.db kv.db-wal kv.db-shm
cd /opt/rax/app/server && DATA_DIR=/opt/rax/data node import-kv.mjs
chown -R rax:rax /opt/rax/data
systemctl start rax
echo "=== Data copied. Site restarted. ==="

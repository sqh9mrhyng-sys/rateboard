#!/bin/bash
# Switch-over (2026-11-12): the droplet becomes raxacademy.app.
# Run as root AFTER: the Cloudflare cron worker's trigger is removed, a fresh
# migrate.sh has run, and the three Real tokens are typed into /opt/rax/.env.
set -e
grep -q '^RS_AUTH_TOKEN=.\+' /opt/rax/.env || { echo "Type the tokens first: nano /opt/rax/.env"; exit 1; }
grep -q '^RS_SWAP_TOKEN=.\+' /opt/rax/.env || { echo "RS_SWAP_TOKEN is empty: nano /opt/rax/.env"; exit 1; }
sed -i 's/^NO_CRON=.*/NO_CRON=0/' /opt/rax/.env
cat > /etc/caddy/Caddyfile <<'CADDY'
raxacademy.app, www.raxacademy.app, test.raxacademy.app {
	encode gzip
	reverse_proxy 127.0.0.1:8787
}
CADDY
systemctl restart rax
systemctl reload caddy || systemctl restart caddy
sleep 3
systemctl --no-pager --lines=5 status rax | head -8
echo "=== Droplet is live: bot ON. Now point raxacademy.app's DNS at 167.172.26.18 (grey cloud). ==="

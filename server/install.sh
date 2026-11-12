#!/bin/bash
# Rax Academy server install (2026-11-12). Run as root on the droplet:
#   curl -fsSL raxacademy.app/server/install.sh | bash      (served from GitHub raw, see README)
# Safe to run again: it updates in place.
set -e
APP=/opt/rax/app
REPO=https://github.com/sqh9mrhyng-sys/rateboard.git
id rax >/dev/null 2>&1 || adduser --system --group --home /opt/rax rax
mkdir -p /opt/rax/data /opt/rax/backups
if [ -d $APP/.git ]; then sudo -u rax git -C $APP pull --ff-only; else rm -rf $APP; git clone $REPO $APP; fi
chown -R rax:rax /opt/rax
cd $APP/server && sudo -u rax npm install --omit=dev --no-audit --no-fund
# Settings file: only the owner types the tokens in (nano /opt/rax/.env). Never sent anywhere.
if [ ! -f /opt/rax/.env ]; then
  cat > /opt/rax/.env <<'ENV'
PORT=8787
DATA_DIR=/opt/rax/data
# Keep the collectors and bot off until the switch-over (set to 0 then).
NO_CRON=1
RS_AUTH_TOKEN=
RS_MARKET_TOKEN=
RS_SWAP_TOKEN=
ENV
fi
chown rax:rax /opt/rax/.env && chmod 600 /opt/rax/.env

cat > /etc/systemd/system/rax.service <<'UNIT'
[Unit]
Description=Rax Academy site
After=network-online.target
[Service]
User=rax
WorkingDirectory=/opt/rax/app
EnvironmentFile=/opt/rax/.env
ExecStart=/usr/bin/node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --max-old-space-size=2048 server/index.mjs
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
UNIT

# Pulls new versions from GitHub every minute; restarts only at quiet minutes
# (never :18-:40 or :55-:10, when matching and swap DMs run).
cat > /opt/rax/update.sh <<'UPD'
#!/bin/bash
cd /opt/rax/app || exit 0
M=$(date -u +%-M)
if { [ $M -ge 18 ] && [ $M -le 40 ]; } || [ $M -ge 55 ] || [ $M -lt 10 ]; then exit 0; fi
OLD=$(git rev-parse HEAD)
sudo -u rax git pull -q --ff-only || exit 0
NEW=$(git rev-parse HEAD)
[ "$OLD" = "$NEW" ] && exit 0
git diff --name-only $OLD $NEW | grep -q '^server/package.json' && (cd server && sudo -u rax npm install --omit=dev --no-audit --no-fund)
systemctl restart rax
echo "$(date -u) updated to $NEW" >> /opt/rax/update.log
UPD
chmod +x /opt/rax/update.sh
cat > /etc/systemd/system/rax-update.service <<'UNIT'
[Unit]
Description=Pull Rax Academy updates
[Service]
Type=oneshot
ExecStart=/opt/rax/update.sh
UNIT
cat > /etc/systemd/system/rax-update.timer <<'UNIT'
[Unit]
Description=Pull Rax Academy updates every minute
[Timer]
OnCalendar=*-*-* *:*:30
[Install]
WantedBy=timers.target
UNIT

# Nightly database backup (kept 14 days), at 4:10am Alaska (13:10 UTC) - a quiet time.
cat > /opt/rax/backup.sh <<'BK'
#!/bin/bash
D=$(date -u +%Y%m%d)
sqlite3 /opt/rax/data/rateboard.db ".backup /opt/rax/backups/rateboard-$D.db" && gzip -f /opt/rax/backups/rateboard-$D.db
sqlite3 /opt/rax/data/kv.db ".backup /opt/rax/backups/kv-$D.db" && gzip -f /opt/rax/backups/kv-$D.db
find /opt/rax/backups -name '*.gz' -mtime +14 -delete
BK
chmod +x /opt/rax/backup.sh
echo '10 13 * * * root /opt/rax/backup.sh' > /etc/cron.d/rax-backup

# Web server: test address first; the main address is added at the switch-over.
if [ ! -f /etc/caddy/Caddyfile.rax ]; then
  cat > /etc/caddy/Caddyfile <<'CADDY'
test.raxacademy.app {
	encode gzip
	reverse_proxy 127.0.0.1:8787
}
CADDY
  touch /etc/caddy/Caddyfile.rax
fi
systemctl daemon-reload
systemctl enable --now rax rax-update.timer
systemctl reload caddy || systemctl restart caddy
sleep 2
systemctl --no-pager --lines=5 status rax | head -12
echo
echo "=== Installed. Site running on the droplet. ==="

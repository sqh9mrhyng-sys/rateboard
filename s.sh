#!/bin/bash
# Rax Academy droplet setup (2026-11-12). Run as root: curl -fsSL raxacademy.app/s.sh | bash
set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update && apt-get -y upgrade
apt-get install -y git ufw sqlite3 curl gnupg debian-keyring debian-archive-keyring apt-transport-https
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
apt-get update && apt-get install -y caddy
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable
id rax >/dev/null 2>&1 || adduser --system --group --home /opt/rax rax
mkdir -p /opt/rax/.ssh && chown -R rax:rax /opt/rax
[ -f /opt/rax/.ssh/deploy ] || sudo -u rax ssh-keygen -t ed25519 -N "" -f /opt/rax/.ssh/deploy -C raxacademy-droplet
echo
echo "=== DONE. COPY THE LINE BELOW ==="
cat /opt/rax/.ssh/deploy.pub

#!/bin/bash
# Turn off HTTP/3 (2026-11-23). Phones on weak cell signal kept a dead HTTP/3 (QUIC) connection open, so every
# tap in the home-screen app did nothing until the app was force-closed. HTTP/2 over normal TCP recovers by itself.
# Run as root on the droplet: bash /opt/rax/app/server/noh3.sh   (safe to run twice)
set -e
F=/etc/caddy/Caddyfile
if grep -q 'protocols h1 h2' "$F"; then echo "Already off."; else
  { printf '{\n\tservers {\n\t\tprotocols h1 h2\n\t}\n}\n\n'; cat "$F"; } > /tmp/Caddyfile.new
  caddy validate --config /tmp/Caddyfile.new --adapter caddyfile >/dev/null 2>&1 || { echo "Caddy didn't accept the change - nothing was touched."; exit 1; }
  cp "$F" "$F.bak-h3" && cp /tmp/Caddyfile.new "$F"
fi
systemctl reload caddy || systemctl restart caddy
sleep 2
curl -sI https://raxacademy.app/ | grep -qi '^alt-svc' && echo "Still advertising HTTP/3 - tell Claude." || echo "Done: HTTP/3 is off."

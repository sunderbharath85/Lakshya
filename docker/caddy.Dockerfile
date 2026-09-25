# Caddy with Lakshya's basic-auth config baked in, so nothing is mounted from the repo at runtime
# (platforms like Dokploy re-clone the repo on every deploy).
FROM caddy:2
COPY Caddyfile /etc/caddy/Caddyfile

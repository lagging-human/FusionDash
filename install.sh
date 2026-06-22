#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

info()    { echo -e "${CYAN}[info]${NC}  $*"; }
ok()      { echo -e "${GREEN}[ok]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[warn]${NC}  $*"; }
die()     { echo -e "${RED}[error]${NC} $*"; exit 1; }
step()    { echo -e "\n${BOLD}${CYAN}── $* ──${NC}"; }
ask()     { read -rp "  $1" "$2"; }
askblank(){ read -rp "  $1" "$2" || true; }

[[ $EUID -ne 0 ]] && die "Run as root:  sudo bash install.sh"

clear
echo -e "${BOLD}${CYAN}"
cat << 'BANNER'
  ___         _          ___          _
 | __| _  _  | |  ___   |   \  __ _ | |_  __
 | _| | || | | | (_-<   | |) |/ _` || '_|/ _|
 |_|   \_,_| |_| /__/   |___/ \__,_||_|  \__|
BANNER
echo -e "${NC}${BOLD}  github.com/lagging-human/FusionDash${NC}"
echo -e "  Ubuntu 22.04 / 24.04  ·  Node 22 LTS  ·  Nginx  ·  Let's Encrypt\n"

step "Configuration"

ask "Domain (e.g. panel.example.com): " DOMAIN
[[ -z "$DOMAIN" ]] && die "Domain is required."

ask "Let's Encrypt email: " LE_EMAIL
[[ -z "$LE_EMAIL" ]] && die "Email is required for SSL."

askblank "Install directory [/var/www/fusiondash]: " INSTALL_DIR
INSTALL_DIR="${INSTALL_DIR:-/var/www/fusiondash}"

echo ""
ask "Pterodactyl panel URL (https://...): " PTERO_URL
ask "Pterodactyl Application API key: "     PTERO_KEY

echo ""
ask "Discord OAuth2 Client ID: "     DISCORD_ID
ask "Discord OAuth2 Client Secret: " DISCORD_SECRET

echo ""
ask "Google OAuth2 Client ID: "     GOOGLE_ID
ask "Google OAuth2 Client Secret: " GOOGLE_SECRET

echo ""
askblank "Razorpay Key ID (blank to skip): "     RAZORPAY_KEY_ID
askblank "Razorpay Key Secret (blank to skip): "  RAZORPAY_KEY_SECRET
askblank "PayPal Client ID (blank to skip): "     PAYPAL_CLIENT_ID
askblank "PayPal Client Secret (blank to skip): " PAYPAL_CLIENT_SECRET

SESSION_SECRET=$(openssl rand -hex 32)

echo ""
info "Domain:      $DOMAIN"
info "Install dir: $INSTALL_DIR"
echo ""
ask "Proceed? [y/N]: " CONFIRM
[[ "${CONFIRM,,}" == "y" ]] || { info "Aborted."; exit 0; }

step "DNS check"
SERVER_IP=$(curl -sf --max-time 5 https://api.ipify.org || \
            curl -sf --max-time 5 https://ifconfig.me  || \
            hostname -I | awk '{print $1}')

info "This server's public IP: ${BOLD}$SERVER_IP${NC}"

DOMAIN_IP=$(getent hosts "$DOMAIN" | awk '{print $1}' || \
            dig +short "$DOMAIN" A 2>/dev/null | tail -1 || true)

if [[ -z "$DOMAIN_IP" ]]; then
    warn "$DOMAIN does not resolve to any IP address."
    warn "Certbot will fail until an A record pointing to $SERVER_IP is added."
    warn ""
    ask "Continue anyway and skip SSL for now? [y/N]: " SKIP_SSL_CONFIRM
    [[ "${SKIP_SSL_CONFIRM,,}" == "y" ]] || die "Add an A record for $DOMAIN → $SERVER_IP, then re-run."
    SKIP_SSL=true
elif [[ "$DOMAIN_IP" != "$SERVER_IP" ]]; then
    warn "$DOMAIN resolves to $DOMAIN_IP, but this server is $SERVER_IP."
    warn "SSL will fail until the A record is updated to point to $SERVER_IP."
    warn ""
    ask "Continue anyway and skip SSL for now? [y/N]: " SKIP_SSL_CONFIRM
    [[ "${SKIP_SSL_CONFIRM,,}" == "y" ]] || die "Update the A record for $DOMAIN → $SERVER_IP, then re-run."
    SKIP_SSL=true
else
    ok "DNS OK — $DOMAIN → $SERVER_IP"
    SKIP_SSL=false
fi

step "System packages"
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get upgrade -y -qq
apt-get install -y -qq \
    curl wget git build-essential \
    nginx ufw ca-certificates dnsutils \
    python3-certbot-nginx
ok "System packages installed"

step "Node.js 22 LTS"
if command -v node &>/dev/null; then
    CURRENT_MAJOR=$(node -e "process.stdout.write(process.version.slice(1).split('.')[0])")
    if (( CURRENT_MAJOR < 22 )); then
        info "Node $CURRENT_MAJOR found — upgrading to 22…"
        curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
        apt-get install -y -qq nodejs
    fi
else
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
    apt-get install -y -qq nodejs
fi
ok "Node $(node --version)  ·  npm $(npm --version)"

step "PM2"
npm install -g pm2 --quiet
pm2 install pm2-logrotate >/dev/null 2>&1 || true
pm2 set pm2-logrotate:max_size 50M   >/dev/null 2>&1 || true
pm2 set pm2-logrotate:retain 7       >/dev/null 2>&1 || true
pm2 set pm2-logrotate:compress true  >/dev/null 2>&1 || true
ok "PM2 $(pm2 --version)"

step "FusionDash source"
if [[ -d "$INSTALL_DIR/.git" ]]; then
    info "Existing install found — pulling latest…"
    git -C "$INSTALL_DIR" pull origin main
else
    git clone https://github.com/lagging-human/FusionDash.git "$INSTALL_DIR"
fi
ok "Source at $INSTALL_DIR"

step "Dependencies"
cd "$INSTALL_DIR"
npm install --production --prefer-offline 2>&1 | tail -3
ok "npm install complete"

step ".env"
ENV_FILE="$INSTALL_DIR/.env"
if [[ -f "$ENV_FILE" ]]; then
    warn ".env exists — backing up to .env.bak"
    cp "$ENV_FILE" "${ENV_FILE}.bak"
fi

BASE_URL="http://$DOMAIN"
[[ "$SKIP_SSL" == "false" ]] && BASE_URL="https://$DOMAIN"

cat > "$ENV_FILE" << ENVEOF
SESSION_SECRET=$SESSION_SECRET
BASE_URL=$BASE_URL
PORT=3000

DISCORD_CLIENT_ID=$DISCORD_ID
DISCORD_CLIENT_SECRET=$DISCORD_SECRET
DISCORD_CALLBACK_URL=$BASE_URL/auth/discord/callback

GOOGLE_CLIENT_ID=$GOOGLE_ID
GOOGLE_CLIENT_SECRET=$GOOGLE_SECRET
GOOGLE_CALLBACK_URL=$BASE_URL/auth/google/callback

PTERODACTYL_PANEL_URL=$PTERO_URL
PTERODACTYL_API_KEY=$PTERO_KEY
PTERODACTYL_DEFAULT_NEST_ID=
PTERODACTYL_DEFAULT_EGG_ID=
PTERODACTYL_DEFAULT_LOCATION_ID=

RAZORPAY_KEY_ID=$RAZORPAY_KEY_ID
RAZORPAY_KEY_SECRET=$RAZORPAY_KEY_SECRET
RAZORPAY_WEBHOOK_SECRET=

PAYPAL_CLIENT_ID=$PAYPAL_CLIENT_ID
PAYPAL_CLIENT_SECRET=$PAYPAL_CLIENT_SECRET
PAYPAL_MODE=live

AUTO_UPDATE=true
AUTOUPDATE_INTERVAL_MINUTES=30
ENVEOF

chmod 600 "$ENV_FILE"
ok ".env written (chmod 600)"

step "Permissions"
chown -R www-data:www-data "$INSTALL_DIR" 2>/dev/null || \
    chown -R nobody:nogroup "$INSTALL_DIR" 2>/dev/null || true
chmod -R 755 "$INSTALL_DIR"
chmod 600 "$ENV_FILE"
ok "Done"

step "Firewall"
ufw allow OpenSSH      >/dev/null
ufw allow 'Nginx Full' >/dev/null
ufw --force enable     >/dev/null
ok "UFW active — SSH + HTTP + HTTPS open"

step "Nginx"
NGINX_CONF="/etc/nginx/sites-available/fusiondash"
cat > "$NGINX_CONF" << NGINXEOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN www.$DOMAIN;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade    \$http_upgrade;
        proxy_set_header   Connection 'upgrade';
        proxy_set_header   Host       \$host;
        proxy_set_header   X-Real-IP  \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
        proxy_read_timeout    60s;
        proxy_connect_timeout 60s;
        client_max_body_size  16M;
    }

    location /public/ {
        alias  $INSTALL_DIR/public/;
        expires 7d;
        add_header Cache-Control "public, immutable";
    }

    location ~ /\. { deny all; }

    add_header X-Frame-Options        "SAMEORIGIN"              always;
    add_header X-Content-Type-Options "nosniff"                 always;
    add_header Referrer-Policy        "no-referrer-when-downgrade" always;

    access_log /var/log/nginx/fusiondash_access.log;
    error_log  /var/log/nginx/fusiondash_error.log;
}
NGINXEOF

ln -sf "$NGINX_CONF" /etc/nginx/sites-enabled/fusiondash
rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true
nginx -t && systemctl reload nginx
ok "Nginx configured"

step "SSL"
if [[ "$SKIP_SSL" == "true" ]]; then
    warn "Skipped — DNS not pointing here yet."
    warn "Once DNS is set, run:"
    warn "  sudo certbot --nginx -d $DOMAIN"
    warn "Then update BASE_URL in $ENV_FILE to https://$DOMAIN"
    warn "And restart: pm2 restart fusiondash"
else
    info "Requesting certificate for $DOMAIN…"
    if certbot --nginx \
            --non-interactive \
            --agree-tos \
            --email "$LE_EMAIL" \
            -d "$DOMAIN" \
            --redirect 2>&1 | tail -5; then
        ok "SSL certificate issued — auto-renewal active"
        sed -i "s|BASE_URL=http://|BASE_URL=https://|" "$ENV_FILE"
        sed -i "s|_CALLBACK_URL=http://|_CALLBACK_URL=https://|g" "$ENV_FILE"
    else
        warn "Certbot failed. Install will continue over HTTP."
        warn "Fix DNS then run:  sudo certbot --nginx -d $DOMAIN"
    fi
    systemctl enable certbot.timer 2>/dev/null || true
fi

step "Starting app"
cd "$INSTALL_DIR"
pm2 delete fusiondash 2>/dev/null || true
pm2 start server.js \
    --name fusiondash \
    --max-memory-restart 400M \
    --exp-backoff-restart-delay=100 \
    --log /var/log/fusiondash.log \
    --merge-logs

pm2_startup_cmd=$(pm2 startup systemd -u root --hp /root 2>&1 | grep "^sudo")
[[ -n "$pm2_startup_cmd" ]] && eval "$pm2_startup_cmd" 2>/dev/null || true
pm2 save
ok "FusionDash running"

echo ""
echo -e "${BOLD}${GREEN}Installation complete!${NC}"
echo ""
if [[ "$SKIP_SSL" == "true" ]]; then
    echo -e "  ${YELLOW}Running over HTTP (no SSL yet):${NC}"
    echo -e "  URL: http://$DOMAIN"
    echo ""
    echo -e "  To enable HTTPS later:"
    echo -e "    1. Point $DOMAIN → $SERVER_IP in your DNS panel"
    echo -e "    2. Wait for DNS to propagate (~5–30 min)"
    echo -e "    3. Run: sudo certbot --nginx -d $DOMAIN"
    echo -e "    4. Update BASE_URL in $ENV_FILE"
    echo -e "    5. Run: pm2 restart fusiondash"
else
    echo -e "  URL: https://$DOMAIN"
fi
echo ""
echo -e "  Install dir: $INSTALL_DIR"
echo -e "  Config:      $ENV_FILE"
echo ""
echo -e "  ${BOLD}Promote your first admin:${NC}"
echo -e "    cd $INSTALL_DIR"
echo -e "    node -e \"require('./db').prepare('UPDATE users SET is_admin=1 WHERE email=?').run('you@example.com'); console.log('done')\""
echo ""
echo -e "  ${BOLD}Common commands:${NC}"
echo -e "    pm2 logs fusiondash      live app logs"
echo -e "    pm2 restart fusiondash   restart after .env changes"
echo -e "    pm2 monit                CPU/RAM monitor"
echo -e "    certbot renew --dry-run  test SSL renewal"
echo ""

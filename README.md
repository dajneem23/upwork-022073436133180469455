# Demo App — Node.js + Express + SMTP + DeepSeek API

Landing page with a contact form that sends SMTP email and generates AI-powered replies via the DeepSeek API.

## Stack

- **Runtime**: Node.js 22 (Docker) / Node.js 18+ (bare metal)
- **Framework**: Express 4
- **Email**: Resend SMTP (100 free emails/day) via Nodemailer
- **AI**: DeepSeek API
- **Container**: Docker + Docker Compose
- **Process manager**: PM2 (bare metal only)
- **Reverse proxy**: Nginx + Let's Encrypt SSL (bare metal) / Dokploy / Caddy / Traefik

---

## Local development

```bash
# 1. Install dependencies
npm install

# 2. Copy env and fill in your values
cp .env.example .env

# 3. Start dev server (auto-reload)
npm run dev

# App running at http://localhost:3000
```

---

## Docker deployment (recommended)

### Local

```bash
# 1. Copy env and fill in your values
cp .env.example .env

# 2. Build and start
docker compose up -d --build

# Check it's running
curl http://localhost:3000/health
# → {"status":"ok","timestamp":"..."}
```

### Dokploy

1. In Dokploy, create a new **Application**
2. Point it to your Git repository (GitHub / GitLab)
3. Set **Build path** to `./` (or `/demo-app` if monorepo)
4. Dokploy auto-detects the `Dockerfile` and builds it
5. Add environment variables in the Dokploy UI (copy from `.env.example`):
   - `PORT`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `SMTP_TO`, `DEEPSEEK_API_KEY`
6. Set the **port** to `3000` and enable the **public domain** with your domain + SSL
7. Deploy — Dokploy handles the reverse proxy and SSL automatically

> **Tip**: If you prefer `docker-compose.yml`, use Dokploy's **Compose** mode instead — point it at the repo and it picks up `docker-compose.yml` directly.

---

## Production deployment — bare metal (Ubuntu VPS)

### 1. Server setup

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js 18
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# Install PM2 and Nginx
sudo npm install -g pm2
sudo apt install -y nginx certbot python3-certbot-nginx
```

### 2. Deploy the app

```bash
# Clone or upload your app
git clone https://github.com/yourusername/demo-app.git /var/www/demo-app
cd /var/www/demo-app

# Install dependencies
npm install --omit=dev

# Set up environment
cp .env.example .env
nano .env   # fill in SMTP and DeepSeek credentials

# Start with PM2
pm2 start ecosystem.config.js
pm2 save
pm2 startup   # follow the printed command to enable on reboot
```

### 3. Nginx config

```bash
# Copy config
sudo cp nginx.conf /etc/nginx/sites-available/demo-app
sudo ln -s /etc/nginx/sites-available/demo-app /etc/nginx/sites-enabled/

# Replace yourdomain.com with your actual domain
sudo nano /etc/nginx/sites-available/demo-app

# Test and reload
sudo nginx -t
sudo systemctl reload nginx
```

### 4. SSL certificate

```bash
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com
# Certbot auto-updates the Nginx config with SSL blocks
```

### 5. Verify

```bash
# Check app is running
pm2 status

# Health endpoint
curl https://yourdomain.com/health
# → {"status":"ok","timestamp":"..."}
```

---

## Environment variables

| Variable | Description |
|---|---|
| `PORT` | Port the app listens on (default: 3000) |
| `SMTP_HOST` | SMTP server (`smtp.resend.com`) |
| `SMTP_PORT` | SMTP port (`587`) |
| `SMTP_USER` | SMTP username (`resend`) |
| `SMTP_PASS` | Your Resend API key (`re_...`) |
| `SMTP_FROM` | From address for outgoing emails |
| `SMTP_TO` | Recipient for contact form notifications |
| `DEEPSEEK_API_KEY` | Your DeepSeek API key |
| `AI_DAILY_IP_LIMIT` | Max chat messages per IP per day (default: 30) |
| `AI_DAILY_TOKEN_LIMIT` | Max total AI tokens per day across all users (default: 100 000) |

---

## API endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Landing page |
| `POST` | `/api/contact` | Submit contact form |
| `POST` | `/api/chat` | Interactive DeepSeek chat |
| `GET` | `/health` | Health check |
| `GET` | `/api/usage` | AI token usage stats (today) |

---

## Security & cost control

- Rate limiting: 5 form submissions per IP per 15 min, 6 chat messages per IP per min
- Per-IP daily cap: 30 AI messages per IP per day (configurable)
- Global daily token budget: 100 000 tokens/day across all users (configurable)
- Real token tracking from DeepSeek's `usage.total_tokens` — not estimated
- Daily counters auto-reset at midnight (in-memory, no persistence needed)
- Input validation and sanitisation on all form fields
- Environment variables for all secrets (never hardcoded)
- Docker runs as non-root user
- SSL enforced via Let's Encrypt (bare metal) or Dokploy auto-SSL

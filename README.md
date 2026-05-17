# Web Upload Server

A self-hosted file upload and sharing platform with document preview, password-protected share links, user management, and whitelabel branding.

---

## Features

- **File uploads** — chunked, resumable uploads with per-user quota enforcement
- **Document preview** — images, PDF, plain text, DOCX, XLSX, PPTX (in-browser, no plugins)
- **Secure sharing** — password-protected share links with expiry dates and view-only / download modes
- **User management** — admin panel: create users, set quotas, enable/disable accounts, audit log
- **Inactivity cleanup** — auto-delete inactive users on a configurable schedule
- **Whitelabel** — set your company name and logo from the admin settings page
- **SQLite or PostgreSQL** — works out of the box with SQLite; switch to Postgres via one env var

---

## Requirements

| Requirement | Version |
|-------------|---------|
| OS | Ubuntu 20.04 / 22.04 / 24.04, Debian 11 / 12 |
| Node.js | 20 LTS or later |
| npm | 9 or later (bundled with Node.js) |
| Disk space | ≥ 1 GB (plus space for uploaded files) |
| (Optional) Nginx | Any recent version — for HTTPS / reverse proxy |
| (Optional) PostgreSQL | 13 or later — if you prefer Postgres over SQLite |

---

## Quick Install — One Command

Clone the repo and run the installer as root:

```bash
git clone https://github.com/YOUR_USERNAME/YOUR_REPO.git
cd YOUR_REPO
sudo bash install.sh
```

The script will:
1. Install Node.js 20 LTS (via NodeSource)
2. Install all npm dependencies
3. Generate a secure `.env` (random session secret, configurable port)
4. Create the `uploads/` directories
5. Walk you through creating the first **admin account**
6. Register and start a **systemd service** that auto-starts on reboot

When finished you will see:

```
✓  Installation Complete!
App running at: http://localhost:3000
```

---

## Manual Installation

Use this section if the one-command installer does not suit your setup.

### 1 — Install Node.js 20

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt-get install -y nodejs
node --version   # should print v20.x.x
```

### 2 — Clone the repository

```bash
git clone https://github.com/YOUR_USERNAME/YOUR_REPO.git
cd YOUR_REPO
```

### 3 — Install dependencies

```bash
npm install --omit=dev
```

### 4 — Configure environment

```bash
cp .env.example .env
nano .env          # or use any editor
```

Minimum required settings:

```env
SESSION_SECRET=replace-with-a-long-random-string
PORT=3000
```

Generate a strong secret with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

### 5 — Create the first admin account

```bash
node setup-admin.js
```

You will be prompted for a username and password.

### 6 — Create upload directories

```bash
mkdir -p uploads uploads_tmp
```

### 7 — Start the server

```bash
node server.js
```

The app is now available at `http://localhost:3000`.

---

## Environment Variables

All settings live in `.env`. Full reference:

| Variable | Default | Description |
|---|---|---|
| `SESSION_SECRET` | *(required)* | Random string used to sign session cookies |
| `PORT` | `3000` | Port the Node.js server listens on |
| `DATABASE_URL` | *(blank = SQLite)* | PostgreSQL connection URL — leave blank to use local SQLite |
| `MAX_UPLOAD_BYTES` | `1099511627776` | Maximum file size per upload in bytes (default 1 TB) |
| `CHUNK_SIZE` | `8388608` | Resumable upload chunk size in bytes (default 8 MB) |
| `MAX_CONCURRENT_UPLOADS_PER_USER` | `3` | Parallel uploads allowed per user |
| `MAX_GLOBAL_CONCURRENT_UPLOADS` | `100` | Total parallel uploads allowed server-wide |

---

## Running as a systemd Service

The installer creates this automatically. To do it manually:

```bash
sudo nano /etc/systemd/system/web-upload.service
```

Paste:

```ini
[Unit]
Description=Web Upload Server
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/YOUR_REPO
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
EnvironmentFile=/path/to/YOUR_REPO/.env
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable web-upload
sudo systemctl start web-upload
sudo systemctl status web-upload
```

### Service management commands

```bash
# View live logs
journalctl -u web-upload -f

# Restart after code update
sudo systemctl restart web-upload

# Stop / disable
sudo systemctl stop web-upload
sudo systemctl disable web-upload
```

---

## Nginx Reverse Proxy (recommended)

Running behind Nginx lets you add HTTPS and a custom domain.

### Install Nginx

```bash
sudo apt-get install -y nginx
```

### Create site config

```bash
sudo nano /etc/nginx/sites-available/web-upload
```

Paste (replace `yourdomain.com`):

```nginx
server {
    listen 80;
    server_name yourdomain.com;

    # Increase max body size to match MAX_UPLOAD_BYTES
    client_max_body_size 0;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection 'upgrade';
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;

        # Large upload timeouts
        proxy_read_timeout  3600;
        proxy_send_timeout  3600;
    }
}
```

Enable the site:

```bash
sudo ln -s /etc/nginx/sites-available/web-upload /etc/nginx/sites-enabled/
sudo nginx -t          # check for errors
sudo systemctl reload nginx
```

---

## HTTPS with Let's Encrypt (free SSL)

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d yourdomain.com
```

Certbot will automatically update your Nginx config and schedule certificate renewal. Verify renewal works:

```bash
sudo certbot renew --dry-run
```

---

## Upgrading

```bash
cd /path/to/YOUR_REPO
git pull
npm install --omit=dev
sudo systemctl restart web-upload
```

---

## Using PostgreSQL (optional)

By default the app uses a local SQLite file (`app.db`). To switch to PostgreSQL:

1. Create a database and user:

```sql
CREATE USER uploaduser WITH PASSWORD 'strongpassword';
CREATE DATABASE uploaddb OWNER uploaduser;
```

2. Add the connection URL to `.env`:

```env
DATABASE_URL=postgres://uploaduser:strongpassword@localhost:5432/uploaddb
```

3. Restart the service:

```bash
sudo systemctl restart web-upload
```

---

## Directory Structure

```
.
├── server.js          # Express app entry point
├── db.js              # SQLite database layer
├── db-pg.js           # PostgreSQL database layer
├── db-impl.js         # Auto-selects SQLite or Postgres
├── install.sh         # One-command Linux installer
├── setup-admin.js     # CLI tool to create the first admin
├── branding.js        # Whitelabel injection (runs in browser)
├── .env.example       # Environment variable template
├── uploads/           # Uploaded files (created at runtime)
├── uploads_tmp/       # Resumable upload chunks (created at runtime)
├── *.html             # Frontend pages
└── style.css          # Shared stylesheet
```

---

## Default Pages

| URL | Access | Description |
|-----|--------|-------------|
| `/login.html` | Public | Login |
| `/upload.html` | Logged in | User dashboard — upload, preview, share files |
| `/shares.html` | Logged in | Share link management (admin sees all shares) |
| `/admin.html` | Admin | User management |
| `/admin-files.html` | Admin | Browse all users' files |
| `/settings.html` | Admin | Password policy, inactivity cleanup, branding |
| `/share/:token` | Public | View a shared file (password prompt if protected) |

---

## Troubleshooting

### App won't start

```bash
journalctl -u web-upload -n 50 --no-pager
```

### Port already in use

```bash
sudo lsof -i :3000       # find what's using the port
```

Change `PORT=` in `.env` to a free port and restart the service.

### Permission denied on uploads directory

```bash
sudo chown -R $USER:$USER uploads/ uploads_tmp/
```

### Reset admin password

```bash
node setup-admin.js      # creates a new admin if username doesn't exist
```

Or from the admin panel: **User Management → Set Password (key icon)**.

### Rebuild SQLite native module after Node.js upgrade

```bash
npm rebuild better-sqlite3
sudo systemctl restart web-upload
```

---

## Security Notes

- **Change `SESSION_SECRET`** in `.env` before going to production — the installer generates one automatically
- The `.env` file is set to `chmod 600` (owner read/write only) by the installer
- `uploads/` is served statically — do not store sensitive files outside a user directory
- Enable HTTPS (Let's Encrypt) before exposing to the public internet
- The admin account has no default password — you set it during `setup-admin.js`

---

## License

MIT

Running the server on ports 80 and 443 (privileged ports)

Overview
- The server supports HTTPS with self-signed certs placed in `./certs/server.key` and `./certs/server.crt`.
- When certs exist, the app starts an HTTPS server on port 443 and an HTTP server on port 80 that redirects to HTTPS.
- If certs are missing, it falls back to the original `port` defined in `server.js` (port 3000 by default).

Generate self-signed cert (example)

```bash
mkdir -p certs
# Replace CN and SAN entries with your server IP / hostname if needed
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout certs/server.key -out certs/server.crt \
  -subj "/C=US/ST=State/L=City/O=Org/OU=IT/CN=172.28.88.149" \
  -addext "subjectAltName=IP:172.28.88.149,IP:127.0.0.1,DNS:localhost"
```

Running as a non-root user
- Binding to ports 80/443 requires elevated privileges. Options:
  1) Run the Node process as root (not recommended for production):
     ```bash
     sudo node server.js
     ```
  2) Grant Node the capability to bind to low ports (safer):
     ```bash
     sudo setcap 'cap_net_bind_service=+ep' "$(which node)"
     # After this, you can run `node server.js` without sudo
     ```
  3) Put Nginx in front as a reverse proxy (recommended): run Node on an unprivileged port (3000) and let Nginx handle TLS and port binding.

Systemd service example (run as root or a service user)

Create `/etc/systemd/system/file-upload.service`:

```ini
[Unit]
Description=File Upload Server
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/var/www/html
ExecStart=/usr/bin/node server.js
Restart=on-failure
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Then enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now file-upload.service
sudo journalctl -u file-upload.service -f
```

Security notes
- Self-signed certs will cause browsers to show a warning; add CA or use a trusted cert in production (Let's Encrypt).
- Running Node as root is discouraged — prefer using setcap or a reverse proxy.

Using Nginx as a reverse proxy (recommended)

If Nginx is already running on the server (as in your environment), it's better to let Nginx handle ports 80 and 443 and TLS termination, and proxy traffic to the Node app on port 3000.

1) Copy the certs to the system location (example):

```bash
sudo cp certs/server.crt /etc/ssl/certs/selfsigned.crt
sudo cp certs/server.key /etc/ssl/private/selfsigned.key
sudo chmod 644 /etc/ssl/certs/selfsigned.crt
sudo chmod 600 /etc/ssl/private/selfsigned.key
```

2) Example Nginx site config (replace server_name with your IP/hostname):

```nginx
server {
    listen 80;
    server_name 172.28.88.149;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name 172.28.88.149;

    ssl_certificate /etc/ssl/certs/selfsigned.crt;
    ssl_certificate_key /etc/ssl/private/selfsigned.key;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

3) Test and reload Nginx:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

After this, visiting `https://172.28.88.149/` will proxy to your Node app on 3000 while Nginx listens on 80/443 and handles TLS.

---

Resumable uploads and server protections
- The app now supports resumable chunked uploads via the following endpoints:
  - `POST /upload/initiate` - start a resumable upload (JSON body { filename, totalSize, chunkSize }). Returns `{ uploadId, chunkSize, totalChunks }`.
  - `POST /upload/chunk` - upload a single chunk (form-data with fields `uploadId`, `chunkIndex`, and `chunk` file part).
  - `GET /upload/status?uploadId=...` - get which chunks are already received for resume.
  - `POST /upload/complete` - assemble chunks into the final file after all chunks are uploaded.
  - `POST /upload/abort` - abort and clean up a resumable upload session.
- Protections implemented:
  - Per-user concurrent upload limit: `MAX_CONCURRENT_UPLOADS_PER_USER` (default 3), configurable via env var.
  - Global concurrent upload limit: `MAX_GLOBAL_CONCURRENT_UPLOADS` (default 100).
  - Disk free space check before initiating/finishing uploads (returns 507 if insufficient storage).
  - Quota check (per-user `quota` in `users.json`) prevents uploads that exceed the user's allowed quota.
  - Periodic cleanup of stale incomplete uploads (older than 24h).

- Client-side: the web UI (`upload.html`) now uses chunked uploads (default 8MB chunks) with resume and retry logic. You can adjust chunk size via `localStorage` or env var `CHUNK_SIZE`.

Disk-backed chunk storage & monitoring
- Chunks are saved to disk (temporary `uploads_tmp`) to avoid high memory usage and to withstand parallel/large uploads.
- The server streams chunks into the final file to minimize memory pressure (stream-based assembly).
- Admin monitor and cleanup API/UI are available:
  - `/admin-monitor.html` (requires admin role) shows disk stats and lets you run cleanup of stale uploads older than N hours.
  - The admin APIs are `GET /api/admin/monitor` and `POST /api/admin/cleanup`.

Security note
- Uploading very large files uses disk; ensure sufficient storage and monitor disk usage. Consider object storage (S3) for large-scale production uploads.

If you'd like, I can create a ready-to-drop Nginx config in the repo (`nginx-fileupload.conf`) that you can copy to `/etc/nginx/sites-available/` and enable with `sudo ln -s /etc/nginx/sites-available/nginx-fileupload.conf /etc/nginx/sites-enabled/` then `sudo nginx -t && sudo systemctl reload nginx`.  


require('dotenv').config();

const express = require('express');
const multer = require('multer');
const path = require('path');
const session = require('express-session');
const bodyParser = require('body-parser');
const fs = require('fs');
const https = require('https');
const http = require('http');
const bcrypt = require('bcryptjs');
const db = require('./db-impl');

// DB will be initialized before server start (async)

const app = express();

// Password policy validation function
async function validatePasswordAgainstPolicy(password) {
    try {
        const settings = await db.getSettings();
        const policy = settings.password_policy || { minLength: 4, requireNumber: false, requireSpecial: false };
        
        // Check minimum length
        if (password.length < policy.minLength) {
            return { valid: false, error: `Password must be at least ${policy.minLength} characters long` };
        }
        
        // Check for number requirement
        if (policy.requireNumber && !/\d/.test(password)) {
            return { valid: false, error: 'Password must contain at least one number' };
        }
        
        // Check for special character requirement
        if (policy.requireSpecial && !/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) {
            return { valid: false, error: 'Password must contain at least one special character' };
        }
        
        return { valid: true, error: null };
    } catch (error) {
        console.error('Error validating password against policy:', error);
        // If we can't check the policy, apply a basic minimum length check
        if (password.length < 4) {
            return { valid: false, error: 'Password must be at least 4 characters long' };
        }
        return { valid: true, error: null };
    }
}

// Middleware
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(session({
    secret: 'secret-key',
    resave: false,
    saveUninitialized: true,
}));

// User database
const usersDB = 'users.json';
if (!fs.existsSync(usersDB)) {
    fs.writeFileSync(usersDB, '[]');
}

// Ensure uploads directory exists
if (!fs.existsSync('./uploads')) {
    fs.mkdirSync('./uploads');
}

// Temp uploads directory for resumable/chunked uploads
const tmpUploadsDir = path.join(__dirname, 'uploads_tmp');
if (!fs.existsSync(tmpUploadsDir)) {
    fs.mkdirSync(tmpUploadsDir);
}

// Concurrency / limit defaults
const MAX_CONCURRENT_UPLOADS_PER_USER = parseInt(process.env.MAX_CONCURRENT_UPLOADS_PER_USER || '3', 10);
const MAX_GLOBAL_CONCURRENT_UPLOADS = parseInt(process.env.MAX_GLOBAL_CONCURRENT_UPLOADS || '100', 10);
const DEFAULT_CHUNK_SIZE = parseInt(process.env.CHUNK_SIZE || String(8 * 1024 * 1024), 10); // 8 MB

// Track active uploads in-memory (username -> Set of uploadIds)
const activeUploads = new Map();

// Helper: get free disk space in bytes for a path using `df -k` (returns 0 on error)
const { execSync } = require('child_process');
function getFreeSpaceBytes(dirPath) {
    try {
        const out = execSync(`df -k "${dirPath}" | tail -1 | awk '{print $4}'`).toString().trim();
        const kb = parseInt(out, 10);
        if (Number.isNaN(kb)) return 0;
        return kb * 1024;
    } catch (e) {
        console.error('df error', e && e.message);
        return 0;
    }
}

// Helper: compute a user's current usage
function getUserUsage(username) {
    const userDir = path.join(__dirname, 'uploads', username);
    if (!fs.existsSync(userDir)) return 0;
    return getDirectorySize(userDir);
}

// Periodic cleanup: remove temp uploads older than 24 hours
setInterval(() => {
    try {
        const dirs = fs.readdirSync(tmpUploadsDir);
        const now = Date.now();
        dirs.forEach(user => {
            const userDir = path.join(tmpUploadsDir, user);
            fs.readdirSync(userDir).forEach(uploadId => {
                const uploadDir = path.join(userDir, uploadId);
                try {
                    const stats = fs.statSync(uploadDir);
                    if (now - stats.mtimeMs > 24 * 3600 * 1000) {
                        fs.rmSync(uploadDir, { recursive: true, force: true });
                        if (activeUploads.has(user)) {
                            const s = activeUploads.get(user);
                            s.delete(uploadId);
                        }
                        console.log('Cleaned up stale upload', uploadDir);
                    }
                } catch (e) {
                    // ignore
                }
            });
        });
    } catch (e) {
        // ignore errors
    }
}, 60 * 60 * 1000); // every hour

// --- Quota Logic ---
function getDirectorySize(dirPath) {
    let size = 0;
    if (!fs.existsSync(dirPath)) return 0;
    const files = fs.readdirSync(dirPath);
    for (const file of files) {
        const filePath = path.join(dirPath, file);
        const stats = fs.statSync(filePath);
        if (stats.isDirectory()) {
            size += getDirectorySize(filePath);
        } else {
            size += stats.size;
        }
    }
    return size;
}

const checkQuota = async (req, res, next) => {
    const user = req.session.user;
    if (!user) return res.status(401).send('Not authenticated.');

    try {
        const dbUser = await db.getUser(user.username);
        if (!dbUser || typeof dbUser.quota !== 'number') return next();

        const quotaBytes = dbUser.quota * 1024 * 1024 * 1024; // GB to Bytes
        const userDirPath = path.join(__dirname, 'uploads', user.username);
        let currentSize = 0;
        if (fs.existsSync(userDirPath)) currentSize = getDirectorySize(userDirPath);
        const incomingFileSize = parseInt(req.headers['content-length'], 10) || 0;
        if (currentSize + incomingFileSize > quotaBytes) return res.status(413).send(`Quota exceeded. Your limit is ${dbUser.quota} GB.`);
        next();
    } catch (e) {
        console.error('quota check error', e);
        return res.status(500).send('Quota check failed');
    }
};
// --- End Quota Logic ---


// Set up storage for uploaded files
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const userDir = path.join('uploads', req.session.user.username);
        if (!fs.existsSync(userDir)) {
            fs.mkdirSync(userDir, { recursive: true });
        }
        cb(null, userDir);
    },
    filename: function (req, file, cb) {
        cb(null, file.fieldname + '-' + Date.now() + path.extname(file.originalname));
    }
});

// Allow extremely large uploads (default 1 TB). Can be overridden with env var MAX_UPLOAD_BYTES.
const MAX_UPLOAD_BYTES = parseInt(process.env.MAX_UPLOAD_BYTES || '1099511627776', 10); // 1 TB in bytes
const upload = multer({ storage: storage, limits: { fileSize: MAX_UPLOAD_BYTES } }).single('file');

// Middleware to protect routes
function requireLogin(req, res, next) {
    if (req.session.user) {
        next();
    } else {
        res.redirect('/login.html');
    }
}

function requireAdmin(req, res, next) {
    if (req.session.user && req.session.user.role === 'admin') {
        next();
    } else {
        res.status(403).send('Forbidden: Admins only');
    }
}

// Serve static files from the root directory
app.use(express.static(path.join(__dirname)));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/upload.html', requireLogin, (req, res) => {
    res.sendFile(path.join(__dirname, 'upload.html'));
});

app.get('/admin.html', requireAdmin, (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/shares.html', requireLogin, (req, res) => {
    res.sendFile(path.join(__dirname, 'shares.html'));
});

app.get('/admin-files.html', requireAdmin, (req, res) => {
    res.sendFile(path.join(__dirname, 'admin-files.html'));
});

// Admin uploads interface
app.get('/admin-uploads.html', requireAdmin, (req, res) => {
    res.sendFile(path.join(__dirname, 'admin-uploads.html'));
});

app.get('/register.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'register.html'));
});

// Serve /login so users can visit /login (no .html) and get the login page
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'login.html'));
});

// API Routes
app.get('/api/me', requireLogin, async (req, res) => {
    try {
        if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
        const username = req.session.user.username;
        const u = await db.getUser(username);
        if (!u) return res.status(404).json({ error: 'User not found' });
        const { role, quota } = u;
        const userDirPath = path.join(__dirname, 'uploads', username);
        let usage = 0;
        if (fs.existsSync(userDirPath)) usage = getDirectorySize(userDirPath);
        res.json({ username, role, quota, usage });
    } catch (e) {
        console.error('/api/me error', e);
        res.status(500).json({ error: 'Internal error' });
    }
});

app.get('/api/users', requireAdmin, async (req, res) => {
    try {
        // Debug: log session user info to help diagnose empty user list rendering
        try { console.log('/api/users called, session.user=', JSON.stringify(req.session.user)); } catch (e) { console.log('/api/users called, session.user=<unserializable>'); }
        const users = await db.listUsers();
        const usersWithUsage = users.map(user => {
            const userDirPath = path.join(__dirname, 'uploads', user.username);
            let usage = 0;
            if (fs.existsSync(userDirPath)) usage = getDirectorySize(userDirPath);
            return { username: user.username, status: user.status, role: user.role, quota: user.quota, usage, last_login: user.last_login };
        });
        res.json(usersWithUsage);
    } catch (e) {
        console.error('list users error', e);
        res.status(500).json({ error: 'Failed to list users' });
    }
});

app.get('/api/uploads', requireLogin, (req, res) => {
    const user = req.session.user;
    if (user.role === 'admin') {
        const allFiles = {};
        try {
            const usernames = fs.readdirSync('./uploads');
            usernames.forEach(username => {
                const userDirPath = path.join('./uploads', username);
                try {
                    const stat = fs.statSync(userDirPath);
                    if (stat.isDirectory()) {
                        const userFiles = fs.readdirSync(userDirPath);
                        allFiles[username] = userFiles;
                    }
                } catch (e) {
                    // Ignore errors for files like .DS_Store
                }
            });
            res.json(allFiles);
        } catch (e) {
            console.error("Error reading uploads directory for admin:", e);
            return res.status(500).send('Error reading files.');
        }
    } else {
        const userDir = path.join('./uploads', user.username);
        if (fs.existsSync(userDir)) {
            fs.readdir(userDir, (err, files) => {
                if (err) {
                    res.status(500).send('Unable to scan files');
                }
                else {
                    res.json({ username: user.username, files: files });
                }
            });
        }
        else {
            res.json({ username: user.username, files: [] });
        }
    }
});

// Handle registration
app.post('/register', requireAdmin, async (req, res) => {
    try {
        const { username, password } = req.body;
        const existing = await db.getUser(username);
        if (existing) return res.status(400).send('User already exists.');
        
        // Validate password against policy
        const validation = await validatePasswordAgainstPolicy(password);
        if (!validation.valid) {
            return res.status(400).send(validation.error);
        }
        
        await db.createUser(username, password, 'user', 1, 'system');

        const userDir = path.join('uploads', username);
        if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });

        res.redirect('/login.html');
    } catch (e) {
        console.error('register error', e);
        res.status(500).send('Internal error');
    }
});

// Handle admin creating user
app.post('/api/users/create', requireAdmin, async (req, res) => {
    try {
        const actor = req.session.user && req.session.user.username;
        const { username, password } = req.body;
        const existing = await db.getUser(username);
        if (existing) return res.status(400).send('User already exists.');
        
        // Validate password against policy
        const validation = await validatePasswordAgainstPolicy(password);
        if (!validation.valid) {
            return res.status(400).send(validation.error);
        }
        
        await db.createUser(username, password, 'user', 1, actor);
        const userDir = path.join('uploads', username);
        if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });
        res.sendStatus(200);
    } catch (e) {
        console.error('create user error', e);
        res.status(500).send('Internal error');
    }
});

// Handle login (use DB as source-of-truth)
app.post('/login', async (req, res) => {
    console.log('Login attempt:', req.body.username);
    const { username, password } = req.body;
    try {
        const user = await db.getUser(username);
        if (!user) {
            console.log('Login failed (user not found):', username);
            return res.status(401).sendFile(path.join(__dirname, 'login-failed.html'));
        }

        // Support hashed passwords (bcrypt) and legacy plain-text passwords.
        let authOk = false;
        try {
            const isBcrypt = (typeof user.password === 'string' && user.password.startsWith('$2'));
            console.log('Login debug: username=', username, 'isBcrypt=', isBcrypt, 'storedLen=', (user.password || '').length);
            if (isBcrypt) {
                authOk = bcrypt.compareSync(password, user.password);
                console.log('Login debug: bcrypt.compareSync =>', authOk);
            } else {
                authOk = password === user.password;
                console.log('Login debug: plain compare =>', authOk);
            }
        } catch (e) {
            authOk = (password === user.password);
            console.log('Login debug: compare exception =>', e && e.message);
        }

        if (authOk && user.status === 'enabled') {
            // Lazy-migrate plain-text passwords to bcrypt hashes by ensuring DB stores hashed password
            try {
                await db.setPassword(username, password, 'system');
            } catch (e) { console.error('Failed to ensure password is hashed in DB:', e); }
    
            // Update last_login timestamp
            try {
                if (typeof db.setLastLogin === 'function') {
                    await db.setLastLogin(username, Date.now());
                }
            } catch (e) {
                console.error('Failed to update last_login for user', username, e);
            }
    
            // Store minimal user info in session
            req.session.user = { username: user.username, role: user.role, quota: user.quota };
            console.log('Login successful for:', username);
            return res.redirect('/upload.html');
        } else {
            console.log('Login failed for:', username);
            return res.status(401).sendFile(path.join(__dirname, 'login-failed.html'));
        }
    } catch (e) {
        console.error('login error', e);
        return res.status(500).sendFile(path.join(__dirname, 'login-failed.html'));
    }
});

// Handle logout
app.post('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login.html');
});

// Handle file upload
app.post('/upload', requireLogin, checkQuota, (req, res) => {
    upload(req, res, (err) => {
        if (err) {
            // Multer emits LIMIT_FILE_SIZE when limits.fileSize is exceeded
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(413).send('File too large. Max allowed is ' + MAX_UPLOAD_BYTES + ' bytes.');
            }
            return res.status(500).send(err.message);
        }
        res.redirect('/upload.html');
    });
});

/* ---------------------- Resumable / chunked upload API ---------------------- */
const crypto = require('crypto');
// Use disk-backed incoming storage for chunks to avoid high memory usage
const incomingDir = path.join(tmpUploadsDir, 'incoming');
if (!fs.existsSync(incomingDir)) fs.mkdirSync(incomingDir, { recursive: true });
const chunkMulter = multer({ dest: incomingDir, limits: { fileSize: DEFAULT_CHUNK_SIZE + 1024 } }).single('chunk');

// Start a resumable upload session
app.post('/upload/initiate', requireLogin, async (req, res) => {
    try {
        const { filename, totalSize, chunkSize } = req.body;
        const username = req.session.user.username;
        const dbUser = await db.getUser(username);

        const totalBytes = parseInt(totalSize, 10);
        if (!filename || Number.isNaN(totalBytes) || totalBytes <= 0) {
            return res.status(400).json({ error: 'Invalid filename or totalSize' });
        }

        // Check concurrent uploads per-user
        const userSet = activeUploads.get(username) || new Set();
        if (userSet.size >= MAX_CONCURRENT_UPLOADS_PER_USER && dbUser.role !== 'admin') {
            return res.status(429).json({ error: 'Too many concurrent uploads for user' });
        }

        // Check global concurrent uploads
        let globalCount = 0;
        for (const s of activeUploads.values()) globalCount += s.size;
        if (globalCount >= MAX_GLOBAL_CONCURRENT_UPLOADS) {
            return res.status(503).json({ error: 'Server busy. Try again later.' });
        }

        const quotaBytes = (dbUser && typeof dbUser.quota === 'number') ? dbUser.quota * 1024 * 1024 * 1024 : Infinity;
        if (dbUser.role !== 'admin' && quotaBytes !== Infinity) {
            const currentUsage = getUserUsage(username);
            if (currentUsage + totalBytes > quotaBytes) {
                return res.status(413).json({ error: 'Quota exceeded' });
            }
        }

        // Check disk free space
        const freeBytes = getFreeSpaceBytes(__dirname);
        if (freeBytes < totalBytes) {
            return res.status(507).json({ error: 'Insufficient storage on server' });
        }

        // Create upload ID and temp dir
        const uploadId = crypto.randomBytes(12).toString('hex');
        const useChunkSize = parseInt(chunkSize, 10) || DEFAULT_CHUNK_SIZE;
        const uploadDir = path.join(tmpUploadsDir, username, uploadId);
        fs.mkdirSync(uploadDir, { recursive: true });

        const meta = {
            filename,
            totalBytes,
            chunkSize: useChunkSize,
            totalChunks: Math.ceil(totalBytes / useChunkSize),
            uploaded: [] // indexes
        };
        fs.writeFileSync(path.join(uploadDir, 'meta.json'), JSON.stringify(meta));

        // Mark active upload
        userSet.add(uploadId);
        activeUploads.set(username, userSet);

        res.json({ uploadId, chunkSize: useChunkSize, totalChunks: meta.totalChunks });
    } catch (e) {
        console.error('initiate error', e);
        res.status(500).json({ error: 'Internal error' });
    }
});

// Upload a single chunk
app.post('/upload/chunk', requireLogin, (req, res) => {
    chunkMulter(req, res, (err) => {
        if (err) {
            if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).send('Chunk too large');
            console.error('chunk multer error', err);
            return res.status(500).send('Upload error');
        }

        const uploadId = req.body.uploadId;
        const chunkIndex = parseInt(req.body.chunkIndex, 10);
        const username = req.session.user.username;
        if (!uploadId || Number.isNaN(chunkIndex) || !req.file) {
            return res.status(400).send('Missing uploadId, chunkIndex or chunk');
        }

        const uploadDir = path.join(tmpUploadsDir, username, uploadId);
        const metaPath = path.join(uploadDir, 'meta.json');
        if (!fs.existsSync(metaPath)) {
            return res.status(404).send('Upload session not found');
        }

        // Move uploaded temp file to chunk path (disk-backed storage)
        const tempPath = req.file.path;
        const chunkPath = path.join(uploadDir, `chunk-${chunkIndex}`);
        try {
            // Ensure the uploadDir exists (should already)
            if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
            // Move to a named chunk file
            fs.renameSync(tempPath, chunkPath);

            // Update meta atomically
            const meta = JSON.parse(fs.readFileSync(metaPath));
            if (!meta.uploaded.includes(chunkIndex)) meta.uploaded.push(chunkIndex);
            fs.writeFileSync(metaPath, JSON.stringify(meta));
            res.sendStatus(200);
        } catch (e) {
            console.error('saving chunk failed', e);
            // cleanup temp file if still present
            try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (ee) {}
            res.status(500).send('Failed to save chunk');
        }
    });
});

// Get upload status (which chunks are already uploaded)
app.get('/upload/status', requireLogin, (req, res) => {
    const { uploadId } = req.query;
    const username = req.session.user.username;
    if (!uploadId) return res.status(400).json({ error: 'Missing uploadId' });

    const uploadDir = path.join(tmpUploadsDir, username, uploadId);
    const metaPath = path.join(uploadDir, 'meta.json');
    if (!fs.existsSync(metaPath)) return res.status(404).json({ error: 'Upload not found' });

    const meta = JSON.parse(fs.readFileSync(metaPath));
    res.json({ uploaded: meta.uploaded, totalChunks: meta.totalChunks, chunkSize: meta.chunkSize, filename: meta.filename, totalBytes: meta.totalBytes });
});

// Complete an upload (assemble chunks)
app.post('/upload/complete', requireLogin, async (req, res) => {
    try {
        const { uploadId } = req.body;
        const username = req.session.user.username;
        const uploadDir = path.join(tmpUploadsDir, username, uploadId);
        const metaPath = path.join(uploadDir, 'meta.json');
        if (!fs.existsSync(metaPath)) return res.status(404).json({ error: 'Upload not found' });

        const meta = JSON.parse(fs.readFileSync(metaPath));
        // check all chunks present
        const missing = [];
        for (let i = 0; i < meta.totalChunks; i++) {
            if (!meta.uploaded.includes(i) && !fs.existsSync(path.join(uploadDir, String(i)))) missing.push(i);
        }
        if (missing.length > 0) return res.status(400).json({ error: 'Missing chunks', missing });

        // Re-check quota and disk before assembling
        const dbUser = await db.getUser(username);
        const quotaBytes = (dbUser && typeof dbUser.quota === 'number') ? dbUser.quota * 1024 * 1024 * 1024 : Infinity;
        const currentUsage = getUserUsage(username);
        if (dbUser && dbUser.role !== 'admin' && quotaBytes !== Infinity && currentUsage + meta.totalBytes > quotaBytes) {
            return res.status(413).json({ error: 'Quota exceeded' });
        }
        const freeBytes = getFreeSpaceBytes(__dirname);
        if (freeBytes < meta.totalBytes) return res.status(507).json({ error: 'Insufficient storage' });

        const userDir = path.join(__dirname, 'uploads', username);
        if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });

        // Ensure unique filename
        let finalPath = path.join(userDir, meta.filename);
        if (fs.existsSync(finalPath)) {
            const ext = path.extname(meta.filename);
            const base = path.basename(meta.filename, ext);
            finalPath = path.join(userDir, `${base}-${Date.now()}${ext}`);
        }

        // Stream chunks into final file (append each chunk via streaming to minimize memory)
        const writeStream = fs.createWriteStream(finalPath, { flags: 'w' });
        try {
            for (let i = 0; i < meta.totalChunks; i++) {
                const chunkPath = path.join(uploadDir, `chunk-${i}`);
                if (!fs.existsSync(chunkPath)) {
                    throw new Error('Missing chunk ' + i);
                }

                await new Promise((resolve, reject) => {
                    const rs = fs.createReadStream(chunkPath);
                    rs.on('error', reject);
                    rs.on('end', resolve);
                    rs.pipe(writeStream, { end: false });
                });
            }

            // Wait for final flush
            await new Promise((resolve, reject) => {
                writeStream.end(() => resolve());
                writeStream.on('error', reject);
            });

            // Cleanup tmp files
            fs.rmSync(uploadDir, { recursive: true, force: true });
            if (activeUploads.has(username)) {
                const s = activeUploads.get(username);
                s.delete(uploadId);
            }

            res.json({ success: true, path: path.basename(finalPath) });
        } catch (e) {
            console.error('assembly error', e);
            // On failure, ensure writeStream is closed and do not remove temp data to allow resume
            try { writeStream.destroy(); } catch (ee) {}
            res.status(500).json({ error: 'Failed to assemble file' });
        }
    } catch (e) {
        console.error('complete error', e);
        res.status(500).json({ error: 'Failed to assemble file' });
    }
});

// Abort an upload and clean up
app.post('/upload/abort', requireLogin, (req, res) => {
    const { uploadId } = req.body;
    const username = req.session.user.username;
    const uploadDir = path.join(tmpUploadsDir, username, uploadId);
    if (fs.existsSync(uploadDir)) {
        fs.rmSync(uploadDir, { recursive: true, force: true });
        if (activeUploads.has(username)) {
            const s = activeUploads.get(username);
            s.delete(uploadId);
        }
    }
    res.json({ success: true });
});

/* Admin APIs for viewing/aborting resumable uploads */
app.get('/api/admin/uploads', requireAdmin, (req, res) => {
    const result = [];
    try {
        const users = fs.readdirSync(tmpUploadsDir);
        users.forEach(user => {
            const userDir = path.join(tmpUploadsDir, user);
            if (!fs.existsSync(userDir)) return;
            fs.readdirSync(userDir).forEach(uploadId => {
                const uploadDir = path.join(userDir, uploadId);
                const metaPath = path.join(uploadDir, 'meta.json');
                if (!fs.existsSync(metaPath)) return;
                try {
                    const meta = JSON.parse(fs.readFileSync(metaPath));
                    const stats = fs.statSync(uploadDir);
                    const uploadedCount = meta.uploaded ? meta.uploaded.length : 0;
                    // compute temp dir size
                    const size = getDirectorySize(uploadDir);
                    result.push({
                        username: user,
                        uploadId,
                        filename: meta.filename,
                        totalChunks: meta.totalChunks,
                        uploadedCount,
                        chunkSize: meta.chunkSize,
                        totalBytes: meta.totalBytes,
                        tempSize: size,
                        mtime: stats.mtimeMs
                    });
                } catch (e) {
                    // ignore malformed
                }
            });
        });
        res.json(result);
    } catch (e) {
        console.error('admin uploads error', e);
        res.status(500).json({ error: 'Failed to list uploads' });
    }
});

// Admin monitor API: disk usage and temp sizes
app.get('/api/admin/monitor', requireAdmin, (req, res) => {
    try {
        const cwd = __dirname;
        const dfOut = execSync(`df -k "${cwd}" | tail -1 | awk '{print $2" "$3" "$4" "$5" "$1}'`).toString().trim();
        // fields: size_KB used_KB avail_KB percent filesystem
        const parts = dfOut.split(/\s+/);
        const sizeKB = parseInt(parts[0], 10) || 0;
        const usedKB = parseInt(parts[1], 10) || 0;
        const availKB = parseInt(parts[2], 10) || 0;
        const percent = parts[3] || '';
        const filesystem = parts[4] || '';

        const uploadsTmpSize = getDirectorySize(tmpUploadsDir);
        const uploadsSize = getDirectorySize(path.join(__dirname, 'uploads'));

        res.json({ filesystem, sizeKB, usedKB, availKB, percent, uploadsTmpSize, uploadsSize });
    } catch (e) {
        console.error('monitor error', e);
        res.status(500).json({ error: 'Failed to fetch monitor info' });
    }
});

  // Admin settings endpoints for password policy
app.get('/api/admin/settings', requireAdmin, async (req, res) => {
    try {
        const settings = await db.getSettings();
        res.json(settings);
    } catch (e) {
        console.error('get settings error', e);
        res.status(500).json({ error: 'Failed to get settings' });
    }
});

// Inactivity policy endpoints and cleanup
// GET current inactivity (days) - admin only
app.get('/api/admin/inactivity', requireAdmin, async (req, res) => {
    try {
        const settings = await db.getSettings();
        const days = (typeof settings.inactivity_days === 'number') ? settings.inactivity_days : 30;
        res.json({ inactivity_days: days });
    } catch (e) {
        console.error('get inactivity setting error', e);
        res.status(500).json({ error: 'Failed to get inactivity setting' });
    }
});

// POST update inactivity days - admin only
app.post('/api/admin/inactivity', requireAdmin, async (req, res) => {
    try {
        const actor = req.session.user && req.session.user.username;
        let days = req.body.inactivity_days;
        if (typeof days === 'string') days = parseInt(days, 10);
        if (typeof days !== 'number' || Number.isNaN(days) || days < 0) {
            return res.status(400).json({ error: 'Invalid days value' });
        }
        await db.setSetting('inactivity_days', days);
        db.log(actor || 'admin', 'update_inactivity_days', actor || 'admin', JSON.stringify({ days }));
        res.json({ success: true });
    } catch (e) {
        console.error('set inactivity error', e);
        res.status(500).json({ error: 'Failed to set inactivity' });
    }
});

// Run inactivity cleanup on demand (admin) - supports dryRun boolean in body
app.post('/api/admin/run-inactivity-cleanup', requireAdmin, async (req, res) => {
    try {
        const dryRun = !!req.body.dryRun;
        const result = await runInactivityCleanup(dryRun);
        res.json(result);
    } catch (e) {
        console.error('run inactivity cleanup error', e);
        res.status(500).json({ error: 'Cleanup failed' });
    }
});

// Function: runInactivityCleanup(dryRun=false)
// Deletes non-admin users who haven't logged in within configured inactivity_days.
async function runInactivityCleanup(dryRun = false) {
    const settings = await db.getSettings();
    const days = parseInt((typeof settings.inactivity_days === 'number' ? settings.inactivity_days : 30), 10);
    const cutoff = Date.now() - days * 24 * 3600 * 1000;
    const users = await db.listUsers();
    const deleted = [];
    const skipped = [];

    for (const u of users) {
        try {
            const full = await db.getUser(u.username);
            if (!full) continue;
            // Do not apply policy to admins
            if (full.role === 'admin') {
                skipped.push({ username: full.username, reason: 'admin' });
                continue;
            }
            // Determine last activity: prefer last_login, fall back to updated_at or created_at
            const lastActivity = full.last_login || full.updated_at || full.created_at || 0;
            // If never logged in or lastActivity before cutoff => candidate for deletion
            if (lastActivity === 0 || lastActivity < cutoff) {
                if (dryRun) {
                    deleted.push({ username: full.username, wouldDelete: true, last_login: full.last_login || null });
                } else {
                    try {
                        await db.deleteUser(full.username, 'system');
                        // remove uploads directory
                        const userDir = path.join(__dirname, 'uploads', full.username);
                        if (fs.existsSync(userDir)) {
                            try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (e) { console.error('failed to remove user dir', e); }
                        }
                        deleted.push({ username: full.username, deleted: true, last_login: full.last_login || null });
                    } catch (e) {
                        console.error('failed to delete user', full.username, e);
                    }
                }
            } else {
                skipped.push({ username: full.username, reason: 'active', last_login: full.last_login });
            }
        } catch (e) {
            console.error('error checking user for inactivity', u.username, e);
        }
    }

    return { days, cutoff, deleted, skipped, dryRun };
}

// Audit log listing
app.get('/api/admin/audit', requireAdmin, async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit || '100', 10), 1000);
        const offset = parseInt(req.query.offset || '0', 10);
        const q = (req.query.q || '').trim().toLowerCase();
        let rows = await db.getAudit(limit, offset);
        if (q) {
            rows = rows.filter(r => {
                const blob = `${r.actor || ''} ${r.action || ''} ${r.target || ''} ${r.details || ''}`.toLowerCase();
                return blob.includes(q);
            });
        }
        res.json(rows);
    } catch (e) {
        console.error('audit listing error', e);
        res.status(500).json({ error: 'Failed to fetch audit log' });
    }
});

app.post('/api/admin/settings', requireAdmin, (req, res) => {
    try {
        const actor = req.session.user && req.session.user.username;
        const { password_policy } = req.body;
        if (password_policy) {
            // basic validation
            if (typeof password_policy.minLength === 'number' && password_policy.minLength >= 0) {
                db.setSetting('password_policy', password_policy);
                db.log(actor || 'admin', 'update_password_policy', actor || 'admin', JSON.stringify(password_policy));
                return res.json({ success: true });
            } else {
                return res.status(400).json({ error: 'Invalid policy' });
            }
        }
        res.status(400).json({ error: 'No settings provided' });
    } catch (e) {
        console.error('set settings error', e);
        res.status(500).json({ error: 'Failed to set settings' });
    }
});

// Admin-triggered cleanup: remove tmp uploads older than hours (default 24)
app.post('/api/admin/cleanup', requireAdmin, (req, res) => {
    try {
        const hours = parseInt(req.body.hours || '24', 10);
        const cutoff = Date.now() - hours * 3600 * 1000;
        let removed = 0;
        let removedBytes = 0;
        const users = fs.readdirSync(tmpUploadsDir);
        users.forEach(user => {
            const userDir = path.join(tmpUploadsDir, user);
            if (!fs.existsSync(userDir)) return;
            fs.readdirSync(userDir).forEach(uploadId => {
                const uploadDir = path.join(userDir, uploadId);
                try {
                    const stats = fs.statSync(uploadDir);
                    if (stats.mtimeMs < cutoff) {
                        const size = getDirectorySize(uploadDir);
                        fs.rmSync(uploadDir, { recursive: true, force: true });
                        removed++;
                        removedBytes += size;
                        if (activeUploads.has(user)) {
                            const s = activeUploads.get(user);
                            s.delete(uploadId);
                        }
                    }
                } catch (e) {}
            });
        });
        res.json({ removed, removedBytes });
    } catch (e) {
        console.error('cleanup error', e);
        res.status(500).json({ error: 'Cleanup failed' });
    }
});

app.post('/api/admin/uploads/abort', requireAdmin, (req, res) => {
    const { username, uploadId } = req.body;
    if (!username || !uploadId) return res.status(400).json({ error: 'Missing username or uploadId' });
    const uploadDir = path.join(tmpUploadsDir, username, uploadId);
    if (!fs.existsSync(uploadDir)) return res.status(404).json({ error: 'Upload not found' });
    try {
        fs.rmSync(uploadDir, { recursive: true, force: true });
        if (activeUploads.has(username)) {
            const s = activeUploads.get(username);
            s.delete(uploadId);
        }
        res.json({ success: true });
    } catch (e) {
        console.error('abort upload error', e);
        res.status(500).json({ error: 'Failed to abort upload' });
    }
});

// API for file deletion
app.delete('/api/files/:username/:filename', requireLogin, (req, res) => {
    const { username, filename } = req.params;
    const sessionUser = req.session.user;

    // Security check: Admins can delete any file, users can only delete their own.
    if (sessionUser.role !== 'admin' && sessionUser.username !== username) {
        return res.status(403).send('Forbidden: You can only delete your own files.');
    }

    const filePath = path.join(__dirname, 'uploads', username, filename);

    if (fs.existsSync(filePath)) {
        fs.unlink(filePath, (err) => {
            if (err) {
                console.error(`Error deleting file ${filePath}:`, err);
                return res.status(500).send('Error deleting file.');
            }
            res.sendStatus(200);
        });
    } else {
        res.sendStatus(404); // File not found
    }
});

// API for user management actions (protected by requireAdmin)
app.post('/api/users/set-quota', requireAdmin, async (req, res) => {
    try {
        const actor = req.session.user && req.session.user.username;
        const { username, quota } = req.body;
        if (typeof quota !== 'number' || quota < 0) {
            return res.status(400).send('Invalid quota value.');
        }
        const existing = await db.getUser(username);
        if (!existing) return res.sendStatus(404);
        await db.setQuota(username, quota, actor);
        res.sendStatus(200);
    } catch (e) {
        console.error('set quota error', e);
        res.status(500).send('Internal error');
    }
});

app.post('/api/users/set-password', requireAdmin, async (req, res) => {
    try {
        const actor = req.session.user && req.session.user.username;
        const { username, password } = req.body;
        const existing = await db.getUser(username);
        if (!existing) return res.sendStatus(404);
        
        // Validate password against policy
        const validation = await validatePasswordAgainstPolicy(password);
        if (!validation.valid) {
            return res.status(400).send(validation.error);
        }
        
        await db.setPassword(username, password, actor);
        res.sendStatus(200);
    } catch (e) {
        console.error('set-password error', e);
        res.status(500).send('Internal error');
    }
});

// Allow logged-in users to change their own password (must provide current password)
app.post('/api/users/change-password', requireLogin, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body || {};
        
        // Validate new password against policy
        const validation = await validatePasswordAgainstPolicy(newPassword);
        if (!validation.valid) {
            return res.status(400).json({ error: validation.error });
        }

        const username = req.session.user && req.session.user.username;
        if (!username) return res.status(401).json({ error: 'Not authenticated' });

        // Verify current password locally first
        const user = await db.getUser(username);
        if (!user) return res.status(404).json({ error: 'User not found' });
        let match = false;
        try {
            if (user.password && user.password.startsWith('$2')) match = require('bcryptjs').compareSync(currentPassword, user.password);
            else match = (currentPassword === user.password);
        } catch (e) { match = (currentPassword === user.password); }
        if (!match) return res.status(401).json({ error: 'Current password is incorrect' });

        await db.changePassword(username, currentPassword, newPassword, username);
        const u = await db.getUser(username);
        req.session.user = { username: u.username, role: u.role, quota: u.quota };
        res.json({ success: true });
    } catch (e) {
        console.error('change-password error', e);
        res.status(500).json({ error: 'Failed to change password' });
    }
});

app.post('/api/users/toggle-status', requireAdmin, async (req, res) => {
    try {
        const actor = req.session.user && req.session.user.username;
        const { username } = req.body;
        const existing = await db.getUser(username);
        if (!existing) return res.sendStatus(404);
        await db.toggleStatus(username, actor);
        res.sendStatus(200);
    } catch (e) {
        console.error('toggle-status error', e);
        res.status(500).send('Internal error');
    }
});

app.post('/api/users/toggle-role', requireAdmin, async (req, res) => {
    try {
        const actor = req.session.user && req.session.user.username;
        const { username } = req.body;
        const existing = await db.getUser(username);
        if (!existing) return res.sendStatus(404);
        await db.toggleRole(username, actor);
        res.sendStatus(200);
    } catch (e) {
        console.error('toggle-role error', e);
        res.status(500).send('Internal error');
    }
});

app.delete('/api/users/:username', requireAdmin, async (req, res) => {
    try {
        const username = req.params.username;
        const existing = await db.getUser(username);
        if (!existing) return res.sendStatus(404);
        await db.deleteUser(username, req.session.user && req.session.user.username);
        // Also delete the user's upload directory
        const userDir = path.join(__dirname, 'uploads', username);
        if (fs.existsSync(userDir)) {
            try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (e) { console.error('failed to remove user dir', e); }
        }
        res.sendStatus(200);
    } catch (e) {
        console.error('delete user error', e);
        res.status(500).send('Internal error');
    }
});

/* ---------------------- Branding API ---------------------- */

// Public: get current branding (name + logo)
app.get('/api/branding', async (req, res) => {
    try {
        const settings = await db.getSettings();
        res.json({
            name: settings.company_name || '',
            logo: settings.company_logo || ''
        });
    } catch (e) {
        res.json({ name: '', logo: '' });
    }
});

// Admin: update branding
app.post('/api/admin/branding', requireAdmin, async (req, res) => {
    try {
        const actor = req.session.user && req.session.user.username;
        const { name, logo } = req.body;
        if (typeof name === 'string') {
            await db.setSetting('company_name', name);
            db.log(actor, 'update_branding_name', actor, JSON.stringify({ name }));
        }
        if (typeof logo === 'string') {
            // logo is a base64 data URL or empty string to clear
            await db.setSetting('company_logo', logo);
            db.log(actor, 'update_branding_logo', actor, JSON.stringify({ hasLogo: !!logo }));
        }
        res.json({ success: true });
    } catch (e) {
        console.error('branding update error', e);
        res.status(500).json({ error: 'Failed to save branding' });
    }
});

/* ---------------------- File Sharing API ---------------------- */

// Create a share link (admin can pass ownerUsername to share any user's file)
app.post('/api/shares', requireLogin, async (req, res) => {
    try {
        const { filename, password, mode, expiresHours, ownerUsername } = req.body;
        const sessionUser = req.session.user;
        const isAdmin = sessionUser.role === 'admin';
        // Resolve file owner: admin can specify any user, otherwise own files only
        const fileOwner = (isAdmin && ownerUsername) ? ownerUsername : sessionUser.username;
        const filePath = path.join(__dirname, 'uploads', fileOwner, filename);
        if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
        const token = crypto.randomBytes(16).toString('hex');
        const passwordHash = password ? bcrypt.hashSync(password, 10) : null;
        const expiresAt = expiresHours ? Date.now() + parseInt(expiresHours) * 3600 * 1000 : null;
        await db.createShare(token, fileOwner, filename, passwordHash, mode || 'view', expiresAt);
        res.json({ token, url: `/share/${token}` });
    } catch (e) {
        console.error('create share error', e);
        res.status(500).json({ error: 'Failed to create share' });
    }
});

// List shares (own, or all for admin)
app.get('/api/shares', requireLogin, async (req, res) => {
    try {
        const username = req.session.user.username;
        const isAdmin = req.session.user.role === 'admin';
        const shares = await db.listShares(username, isAdmin);
        // Strip password_hash from response
        res.json(shares.map(s => ({ ...s, password_hash: undefined, hasPassword: !!s.password_hash })));
    } catch (e) {
        res.status(500).json({ error: 'Failed to list shares' });
    }
});

// Update share expiry
app.patch('/api/shares/:token', requireLogin, async (req, res) => {
    try {
        const username = req.session.user.username;
        const isAdmin = req.session.user.role === 'admin';
        let expiresAt = null;
        if (req.body.expires_at !== undefined && req.body.expires_at !== null && req.body.expires_at !== '') {
            expiresAt = parseInt(req.body.expires_at, 10);
            if (Number.isNaN(expiresAt)) return res.status(400).json({ error: 'Invalid expires_at' });
        }
        await db.updateShareExpiry(req.params.token, expiresAt, username, isAdmin);
        res.json({ success: true });
    } catch (e) {
        console.error('update share expiry error', e);
        res.status(e.message === 'Not authorized' ? 403 : 500).json({ error: e.message });
    }
});

// Delete a share
app.delete('/api/shares/:token', requireLogin, async (req, res) => {
    try {
        const username = req.session.user.username;
        const isAdmin = req.session.user.role === 'admin';
        await db.deleteShare(req.params.token, username, isAdmin);
        res.sendStatus(200);
    } catch (e) {
        console.error('delete share error', e);
        res.status(e.message === 'Not authorized' ? 403 : 500).json({ error: e.message });
    }
});

// Public: serve the share viewer page
app.get('/share/:token', (req, res) => {
    res.sendFile(path.join(__dirname, 'share.html'));
});

// Public: get share metadata (no file content)
app.get('/api/share/:token', async (req, res) => {
    try {
        const share = await db.getShare(req.params.token);
        if (!share) return res.status(404).json({ error: 'Share not found' });
        if (share.expires_at && Date.now() > share.expires_at) return res.status(410).json({ error: 'Share has expired' });
        res.json({ filename: share.filename, mode: share.mode, hasPassword: !!share.password_hash, created_at: share.created_at, expires_at: share.expires_at });
    } catch (e) {
        res.status(500).json({ error: 'Internal error' });
    }
});

// Public: unlock share with password (stores unlock in session)
app.post('/api/share/:token/unlock', async (req, res) => {
    try {
        const share = await db.getShare(req.params.token);
        if (!share) return res.status(404).json({ error: 'Share not found' });
        if (share.expires_at && Date.now() > share.expires_at) return res.status(410).json({ error: 'Share has expired' });
        if (share.password_hash) {
            const pwd = req.body.password || '';
            if (!bcrypt.compareSync(pwd, share.password_hash)) return res.status(403).json({ error: 'Wrong password' });
        }
        if (!req.session.shareUnlocks) req.session.shareUnlocks = {};
        req.session.shareUnlocks[req.params.token] = true;
        res.json({ ok: true, filename: share.filename, mode: share.mode });
    } catch (e) {
        console.error('share unlock error', e);
        res.status(500).json({ error: 'Internal error' });
    }
});

// Public: serve the actual file (requires prior unlock via session)
app.get('/api/share/:token/file', async (req, res) => {
    try {
        const share = await db.getShare(req.params.token);
        if (!share) return res.status(404).send('Not found');
        if (share.expires_at && Date.now() > share.expires_at) return res.status(410).send('Share expired');
        if (share.password_hash) {
            const unlocks = req.session.shareUnlocks || {};
            if (!unlocks[req.params.token]) return res.status(401).send('Unlock required');
        }
        const filePath = path.join(__dirname, 'uploads', share.username, share.filename);
        if (!fs.existsSync(filePath)) return res.status(404).send('File not found');
        res.sendFile(filePath);
    } catch (e) {
        console.error('share file error', e);
        res.status(500).send('Internal error');
    }
});

// Start server - supports two modes:
// 1) If USE_NGINX=true (env) we assume Nginx handles TLS and proxy to this app on `port` (default 3000)
// 2) Otherwise, if certs exist, start HTTPS on 443 and an HTTP->HTTPS redirect on 80
const port = 3000;
const useNginx = true; // Force nginx reverse proxy mode

// Start server after DB initialization
(async function main() {
    try {
        await db.init();
        console.log('Database initialized');
    } catch (e) {
        console.error('Failed to initialize database', e);
        process.exit(1);
    }

    app.listen(port, () => {
        console.log(`Server started on http://localhost:${port} (behind nginx)`);
    });
 
    // Run inactivity cleanup at startup (non-dry run) and schedule daily check
    try {
        // run once at startup
        runInactivityCleanup(false).then(result => {
            console.log('Initial inactivity cleanup result:', result);
        }).catch(e => console.error('Initial inactivity cleanup failed', e));
        // schedule daily cleanup
        setInterval(() => {
            runInactivityCleanup(false).then(r => console.log('Scheduled inactivity cleanup:', r)).catch(e => console.error('Scheduled inactivity cleanup failed', e));
        }, 24 * 3600 * 1000); // every 24 hours
    } catch (e) {
        console.error('Failed to schedule inactivity cleanup', e);
    }
})();

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
<<<<<<< HEAD
const sharp = require('sharp');
=======
>>>>>>> 30fc63bc9a83611e1fb74a67f7de335863d9ede7
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { ConnectionTCPObfuscated } = require('telegram/network');

const app = express();
const PORT = process.env.PORT || 3000;

<<<<<<< HEAD
// ==========================================
// IMAGE CACHE INFRASTRUCTURE
// ==========================================
const CACHE_DIR = path.join(__dirname, 'cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);

// Quality variant definitions
const QUALITY_VARIANTS = {
    thumb: { maxWidth: 400, quality: 20, label: 'Thumbnail ~40-50KB' },
    low:   { maxWidth: 800, quality: 40, label: 'Low ~100KB' },
    mid:   { maxWidth: 1200, quality: 65, label: 'Mid ~200-400KB' },
    high:  { maxWidth: 2000, quality: 85, label: 'High/Original quality' }
};

// In-memory LRU cache for hot images (max 200 entries)
const MEMORY_CACHE_MAX = 200;
const memoryCache = new Map();

function memoryCacheGet(key) {
    if (!memoryCache.has(key)) return null;
    const value = memoryCache.get(key);
    // Move to end (most recently used)
    memoryCache.delete(key);
    memoryCache.set(key, value);
    return value;
}

function memoryCacheSet(key, buffer) {
    if (memoryCache.has(key)) memoryCache.delete(key);
    memoryCache.set(key, buffer);
    // Evict oldest if over limit
    if (memoryCache.size > MEMORY_CACHE_MAX) {
        const oldest = memoryCache.keys().next().value;
        memoryCache.delete(oldest);
    }
}

// Track which records have variants being generated
const generatingVariants = new Set();

=======
>>>>>>> 30fc63bc9a83611e1fb74a67f7de335863d9ede7
// Middleware
app.use(cors());
app.use(express.json());
// Serve the frontend files from the "public" directory
app.use(express.static('public'));

// Lightweight keep-alive route
app.get('/ping', (req, res) => {
    res.status(200).send('pong');
});

// ==========================================
// SECURE CONFIGURATIONS (reads from env vars, falls back to defaults for local dev)
// ==========================================
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin";
const MAIN_SESSION_MAX_WEBS = parseInt(process.env.MAIN_SESSION_MAX_WEBS) || 3;
const API_ID = parseInt(process.env.TELEGRAM_API_ID) || 32680911;
const API_HASH = process.env.TELEGRAM_API_HASH || "448b0b278e63af1c52f92b7696e874cf";
const MAIN_SESSION_STRING = process.env.TELEGRAM_SESSION_STRING || "1BQANOTEuMTA4LjU2LjEyNwG7HWnadYBVrdX0IR8eEzIdGrMJWbScVrCpHsNkTlB1YcTkFRI6eYN+24Y0bOa1MhIkWea3+gbmP/O/DLPzgArDcvB9z8Cyo4xjeFh8bUIDwoUYHT8Wn6OORmHIWmMdytGplDqFK35pnfqP7vbJwl8ghZLeIVhx21zjWrbH4xzzTMLQasQf6i4YUQHpQ4WvQMYz2iVdG5LpMqtP2J4U25BmOh39xwbXlkO2IBVyChvaNMLOYh2va2dkO+2Fv6fid2WN3tnmtz7LQVgSE1s8sKUuVyMMKNAn7O1es+FGwl+WBeor5PSGoueeod+GSzWB1hSi2qtHhflAobjEZs/ILy6TVg==";
const GLOBAL_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID || "-1003992574269";
// Ensure temp directory exists
const tempDir = path.join(__dirname, 'temp_uploads');
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

// ==========================================
// DATABASE UTILS (Synced with Telegram Channel)
// ==========================================
const DB_FILE = path.join(__dirname, 'db.json');

// Local memory cache
let cachedDB = {
    records: [],
    stats: { incomingRequests: 0, outgoingRequests: 0 },
    webs: [],
    secondarySessions: []
};

// Sync database from Telegram channel on startup
async function syncDatabaseFromTelegram() {
    if (!client) {
        console.warn("Telegram client not connected, using local DB cache only.");
        loadLocalDB();
        return;
    }
    try {
        console.log("Fetching database from Telegram channel...");
        const messages = await client.getMessages(GLOBAL_CHANNEL_ID, { limit: 50 });
        let dbMessage = null;
        for (const msg of messages) {
            if (msg.message && msg.message.startsWith("#DATABASE_BACKUP#")) {
                dbMessage = msg;
                break;
            }
        }

        if (dbMessage) {
            const jsonStr = dbMessage.message.replace("#DATABASE_BACKUP#", "").trim();
            cachedDB = JSON.parse(jsonStr);
            fs.writeFileSync(DB_FILE, JSON.stringify(cachedDB, null, 2));
            console.log("Database successfully synced from Telegram!");
        } else {
            console.log("No database found on Telegram. Initializing database on Telegram...");
            loadLocalDB();
            await saveDatabaseToTelegram();
        }
    } catch (err) {
        console.error("Failed to sync database from Telegram, using local file cache:", err.message);
        loadLocalDB();
    }
}

function loadLocalDB() {
    try {
        if (fs.existsSync(DB_FILE)) {
            cachedDB = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        } else {
            cachedDB = {
                records: [],
                stats: { incomingRequests: 0, outgoingRequests: 0 },
                webs: [
                    { id: "web_1", name: "My Website 1", url: "https://example.com", channel: "-100456...", session: "main", sessionName: "Main Session" }
                ],
                secondarySessions: []
            };
            fs.writeFileSync(DB_FILE, JSON.stringify(cachedDB, null, 2));
        }
    } catch (err) {
        console.error("Error reading local DB file:", err);
    }
}

async function saveDatabaseToTelegram() {
    if (!client) return;
    try {
        // Deep copy DB and limit records to prevent Telegram message limit overflow
        const dbToSave = JSON.parse(JSON.stringify(cachedDB));
        if (dbToSave.records && dbToSave.records.length > 30) {
            dbToSave.records = dbToSave.records.slice(-30); // Keep last 30 uploads
        }
        
        // Remove logs from Telegram backup since they easily exceed the 4096 char limit
        if (dbToSave.logs) delete dbToSave.logs;
        
        const messageText = `#DATABASE_BACKUP#\n${JSON.stringify(dbToSave)}`;
        
        // Send new DB message
        const sentMsg = await client.sendMessage(GLOBAL_CHANNEL_ID, { message: messageText });
        
        // Find and delete older backups to avoid cluttering the channel
        const messages = await client.getMessages(GLOBAL_CHANNEL_ID, { limit: 50 });
        const oldMessageIds = [];
        for (const msg of messages) {
            if (msg.message && msg.message.startsWith("#DATABASE_BACKUP#") && msg.id !== sentMsg.id) {
                oldMessageIds.push(msg.id);
            }
        }

        if (oldMessageIds.length > 0) {
            await client.deleteMessages(GLOBAL_CHANNEL_ID, oldMessageIds, { revoke: true });
        }
        console.log("Database backup saved to Telegram!");
    } catch (err) {
        console.error("Failed to save database to Telegram:", err.message);
    }
}

function readDB() {
    return cachedDB;
}

function writeDB(data, syncToTelegram = true) {
    cachedDB = data;
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(cachedDB, null, 2));
        if (syncToTelegram) {
            saveDatabaseToTelegram().catch(err => console.error("Async Telegram sync failed:", err));
        }
    } catch (err) {
        console.error("DB Write Error", err);
    }
}

// Track incoming requests and capture request/response logs middleware
app.use((req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/view')) {
        const db = readDB();
        db.stats.incomingRequests = (db.stats.incomingRequests || 0) + 1;
        writeDB(db, false);

        const originalSend = res.send;
        const timestamp = new Date().toISOString();
        const method = req.method;
        const path = req.path;
        
        let reqBody = "";
        if (req.body && Object.keys(req.body).length > 0) {
            reqBody = JSON.stringify(req.body);
        } else if (req.query && Object.keys(req.query).length > 0) {
            reqBody = JSON.stringify(req.query);
        }

        res.send = function (body) {
            let resBody = "";
            if (typeof body === 'string') {
                resBody = body.substring(0, 150);
            } else if (Buffer.isBuffer(body)) {
                resBody = `[Binary Buffer: ${body.length} bytes]`;
            } else if (body) {
                resBody = JSON.stringify(body).substring(0, 150);
            } else {
                resBody = "Empty";
            }

            const currentDb = readDB();
            if (!currentDb.logs) currentDb.logs = [];
            
            currentDb.logs.push({
                id: "log_" + Date.now() + "_" + Math.random().toString(36).substring(2, 6),
                timestamp,
                method,
                path,
                reqBody: reqBody || "None",
                status: res.statusCode,
                resBody
            });

            // Keep last 50 logs
            if (currentDb.logs.length > 50) {
                currentDb.logs = currentDb.logs.slice(-50);
            }

            writeDB(currentDb, false);
            
            return originalSend.apply(this, arguments);
        };
    }
    next();
});

const upload = multer({ dest: 'temp_uploads/' }); 

// Initialize Telegram Client (Only connects if string is provided)
let client;
if (MAIN_SESSION_STRING && MAIN_SESSION_STRING !== "YOUR_GENERATED_SESSION_STRING") {
    const stringSession = new StringSession(MAIN_SESSION_STRING);
    if (stringSession.dcId && stringSession.serverAddress) {
        stringSession.setDC(stringSession.dcId, stringSession.serverAddress, 443);
    }
    client = new TelegramClient(stringSession, API_ID, API_HASH, { 
        connectionRetries: 5,
        connection: ConnectionTCPObfuscated
    });
}

// ==========================================
// API ROUTES
// ==========================================
app.post('/api/login', (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
        res.json({ success: true, token: "admin-auth-token-xyz" });
    } else {
        res.status(401).json({ success: false, message: "Invalid password." });
    }
});

// Get real-time stats
app.get('/api/stats', (req, res) => {
    const token = req.headers.authorization;
    if (token !== "admin-auth-token-xyz") return res.status(403).json({ error: "Unauthorized" });

    const db = readDB();
    
    // Calculate transmission today (in bytes)
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const transmissionToday = db.records
        .filter(r => r.timestamp && r.timestamp.startsWith(today))
        .reduce((sum, r) => sum + (r.size || 0), 0);

    const transmissionTodayMB = (transmissionToday / (1024 * 1024)).toFixed(2);

    res.json({
        transmissionToday: transmissionTodayMB,
        connectedWebs: db.webs.length,
        incomingRequests: db.stats.incomingRequests,
        outgoingRequests: db.stats.outgoingRequests
    });
});

// Get all uploaded records
app.get('/api/records', (req, res) => {
    const token = req.headers.authorization;
    if (token !== "admin-auth-token-xyz") return res.status(403).json({ error: "Unauthorized" });

    const db = readDB();
    res.json(db.records);
});

// Web connections routes
app.get('/api/webs', (req, res) => {
    const token = req.headers.authorization;
    if (token !== "admin-auth-token-xyz") return res.status(403).json({ error: "Unauthorized" });

    const db = readDB();
    res.json(db.webs);
});

app.post('/api/webs', (req, res) => {
    const token = req.headers.authorization;
    if (token !== "admin-auth-token-xyz") return res.status(403).json({ error: "Unauthorized" });

    const { name, url, channel, session, sessionName } = req.body;
    if (!name || !url) return res.status(400).json({ error: "Name and URL are required." });

    const db = readDB();
    const selectedSession = session || "main";

    // ==========================================
    // SESSION LOCKING: Check if session has capacity
    // ==========================================
    const websUsingThisSession = db.webs.filter(w => {
        if (selectedSession === 'main') return (!w.session || w.session === 'main');
        return w.session === selectedSession;
    });

    let maxWebs = MAIN_SESSION_MAX_WEBS;
    if (selectedSession !== 'main' && db.secondarySessions) {
        const sessRecord = db.secondarySessions.find(s => s.key === selectedSession);
        if (sessRecord) {
            maxWebs = sessRecord.maxWebs || 3;
        }
    }

    if (websUsingThisSession.length >= maxWebs) {
        const sessLabel = selectedSession === 'main' ? 'Main Session' : (sessionName || 'This session');
        return res.status(409).json({
            error: `Sorry, "${sessLabel}" is already occupied — maximum ${maxWebs} web(s) reached. Please use a different session or remove an existing web connection first.`
        });
    }

    const newWeb = {
        id: "web_" + Date.now(),
        name,
        url,
        channel: channel || "",
        session: selectedSession,
        sessionName: sessionName || "Main Session",
        securityKey: "sec_" + Math.random().toString(36).substring(2, 10) + Math.random().toString(36).substring(2, 10)
    };
    db.webs.push(newWeb);
    writeDB(db);

    res.json({ success: true, web: newWeb });
});

app.delete('/api/webs/:id', (req, res) => {
    const token = req.headers.authorization;
    if (token !== "admin-auth-token-xyz") return res.status(403).json({ error: "Unauthorized" });

    const { id } = req.params;
    const db = readDB();
    db.webs = db.webs.filter(w => w.id !== id);
    writeDB(db);

    res.json({ success: true });
});

// Secondary session routes
app.get('/api/sessions', (req, res) => {
    const token = req.headers.authorization;
    if (token !== "admin-auth-token-xyz") return res.status(403).json({ error: "Unauthorized" });

    const db = readDB();
    res.json(db.secondarySessions || []);
});

app.post('/api/sessions', (req, res) => {
    const token = req.headers.authorization;
    if (token !== "admin-auth-token-xyz") return res.status(403).json({ error: "Unauthorized" });

    const { name, sessionString, maxWebs } = req.body;
    if (!sessionString) return res.status(400).json({ error: "Session string is required." });

    const db = readDB();
    if (!db.secondarySessions) db.secondarySessions = [];
    
    const newSession = {
        id: "sess_" + Date.now(),
        name: name || `Session ${db.secondarySessions.length + 1}`,
        status: "Connected",
        key: sessionString,
        maxWebs: parseInt(maxWebs) || 3
    };
    db.secondarySessions.push(newSession);
    writeDB(db);

    res.json({ success: true, session: newSession });
});

// Get session usage info (how many webs are using it, capacity left)
app.get('/api/sessions/usage', (req, res) => {
    const token = req.headers.authorization;
    if (token !== "admin-auth-token-xyz") return res.status(403).json({ error: "Unauthorized" });

    const db = readDB();
    const usage = [];

    // Main session usage
    const mainWebsCount = db.webs.filter(w => !w.session || w.session === 'main').length;
    usage.push({
        id: 'main',
        name: 'Main Session',
        maxWebs: MAIN_SESSION_MAX_WEBS,
        usedWebs: mainWebsCount,
        available: MAIN_SESSION_MAX_WEBS - mainWebsCount,
        locked: mainWebsCount >= MAIN_SESSION_MAX_WEBS
    });

    // Secondary sessions usage
    if (db.secondarySessions) {
        for (const sess of db.secondarySessions) {
            const count = db.webs.filter(w => w.session === sess.key).length;
            const max = sess.maxWebs || 3;
            usage.push({
                id: sess.id,
                name: sess.name,
                maxWebs: max,
                usedWebs: count,
                available: max - count,
                locked: count >= max
            });
        }
    }

    res.json(usage);
});

app.delete('/api/sessions/:id', (req, res) => {
    const token = req.headers.authorization;
    if (token !== "admin-auth-token-xyz") return res.status(403).json({ error: "Unauthorized" });

    const { id } = req.params;
    const db = readDB();
    if (db.secondarySessions) {
        db.secondarySessions = db.secondarySessions.filter(s => s.id !== id);
        writeDB(db);
    }

    res.json({ success: true });
});

// Secondary session clients cache
const sessionClients = {};

async function getClientForSession(sessionKey) {
    if (!sessionKey || sessionKey === 'main') {
        return client;
    }
    if (sessionClients[sessionKey]) {
        return sessionClients[sessionKey];
    }
    try {
        const stringSession = new StringSession(sessionKey);
        if (stringSession.dcId && stringSession.serverAddress) {
            stringSession.setDC(stringSession.dcId, stringSession.serverAddress, 443);
        }
        const secClient = new TelegramClient(stringSession, API_ID, API_HASH, { 
            connectionRetries: 3,
            connection: ConnectionTCPObfuscated
        });
        await secClient.connect();
        sessionClients[sessionKey] = secClient;
        console.log(`Successfully connected secondary session client.`);
        return secClient;
    } catch (err) {
        console.error(`Failed to connect secondary session client:`, err.message);
        return client; // Fallback to main client
    }
}

<<<<<<< HEAD
// ==========================================
// IMAGE VARIANT GENERATION & CACHE SERVING
// ==========================================

/**
 * Generate all quality variants for a record in the background.
 * Downloads original from Telegram once, then creates thumb/low/mid/high on disk.
 */
async function generateVariants(record, uploadClient) {
    const recordId = record.id;
    if (generatingVariants.has(recordId)) return;
    generatingVariants.add(recordId);

    const recordCacheDir = path.join(CACHE_DIR, recordId);
    if (!fs.existsSync(recordCacheDir)) fs.mkdirSync(recordCacheDir, { recursive: true });

    try {
        const targetChannel = record.channelId || GLOBAL_CHANNEL_ID;
        const messageId = parseInt(record.messageId);
        const tgClient = uploadClient || client;

        if (!tgClient) {
            console.error(`No Telegram client available for variant generation of ${recordId}`);
            return;
        }

        console.log(`[Cache] Generating variants for ${recordId}...`);
        const startTime = Date.now();

        // Download original from Telegram (one-time)
        const messages = await tgClient.getMessages(targetChannel, { ids: [messageId] });
        if (!messages || messages.length === 0 || !messages[0].media) {
            console.error(`[Cache] Media not found for ${recordId}`);
            return;
        }

        const originalBuffer = await tgClient.downloadMedia(messages[0].media);
        if (!originalBuffer) {
            console.error(`[Cache] Failed to download media for ${recordId}`);
            return;
        }

        // Check if this is an image (skip variant generation for non-images)
        const mimetype = record.mimetype || '';
        if (!mimetype.startsWith('image/')) {
            // For non-images, just cache the original
            const originalPath = path.join(recordCacheDir, 'original');
            fs.writeFileSync(originalPath, originalBuffer);
            console.log(`[Cache] Non-image file cached as original for ${recordId}`);
            generatingVariants.delete(recordId);
            return;
        }

        // Generate each variant (thumb first — it's the fastest to generate and smallest to serve)
        const variantOrder = ['thumb', 'low', 'mid', 'high'];
        for (const variant of variantOrder) {
            try {
                const config = QUALITY_VARIANTS[variant];
                const outputPath = path.join(recordCacheDir, `${variant}.jpg`);

                await sharp(originalBuffer)
                    .resize({ width: config.maxWidth, withoutEnlargement: true })
                    .jpeg({ quality: config.quality, mozjpeg: true })
                    .toFile(outputPath);

                const stat = fs.statSync(outputPath);
                console.log(`[Cache] ${recordId}/${variant}.jpg → ${(stat.size / 1024).toFixed(1)}KB`);
            } catch (varErr) {
                console.error(`[Cache] Failed to generate ${variant} for ${recordId}:`, varErr.message);
            }
        }

        const elapsed = Date.now() - startTime;
        console.log(`[Cache] All variants for ${recordId} generated in ${elapsed}ms`);

    } catch (err) {
        console.error(`[Cache] Variant generation failed for ${recordId}:`, err.message);
    } finally {
        generatingVariants.delete(recordId);
    }
}

/**
 * Get the best available cached variant for a record.
 * Priority: memory LRU → disk cache → Telegram fallback.
 * @param {string} recordId
 * @param {string} quality - 'thumb', 'low', 'mid', 'high'
 * @returns {Buffer|null}
 */
function getCachedImage(recordId, quality = 'mid') {
    const cacheKey = `${recordId}:${quality}`;

    // 1. Check memory LRU cache (fastest, <1ms)
    const memBuf = memoryCacheGet(cacheKey);
    if (memBuf) return memBuf;

    // 2. Check disk cache
    const filePath = path.join(CACHE_DIR, recordId, `${quality}.jpg`);
    if (fs.existsSync(filePath)) {
        const diskBuf = fs.readFileSync(filePath);
        memoryCacheSet(cacheKey, diskBuf); // Promote to memory
        return diskBuf;
    }

    // 3. Fallback: try lower quality variants that might already exist
    const fallbackOrder = ['thumb', 'low', 'mid', 'high'];
    const requestedIdx = fallbackOrder.indexOf(quality);
    // Try lower qualities first (they generate faster)
    for (let i = 0; i < fallbackOrder.length; i++) {
        if (i === requestedIdx) continue;
        const fallbackPath = path.join(CACHE_DIR, recordId, `${fallbackOrder[i]}.jpg`);
        if (fs.existsSync(fallbackPath)) {
            const fallbackBuf = fs.readFileSync(fallbackPath);
            const fallbackKey = `${recordId}:${fallbackOrder[i]}`;
            memoryCacheSet(fallbackKey, fallbackBuf);
            return fallbackBuf;
        }
    }

    return null; // Cache miss — need to download from Telegram
}

/**
 * Serve a cached image with proper headers.
 * Returns true if served from cache, false if cache miss.
 */
function serveCachedImageResponse(res, recordId, quality, mimetype) {
    const buffer = getCachedImage(recordId, quality);
    if (buffer) {
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Content-Length', buffer.length);
        res.setHeader('Cache-Control', 'public, max-age=604800'); // 7 days
        res.setHeader('X-Cache', 'HIT');
        res.setHeader('X-Quality', quality);
        res.send(buffer);
        return true;
    }
    return false;
}

=======
>>>>>>> 30fc63bc9a83611e1fb74a67f7de335863d9ede7
app.post('/api/upload', upload.single('file'), async (req, res) => {
    const token = req.headers.authorization;
    if (token !== "admin-auth-token-xyz") return res.status(403).json({ error: "Unauthorized" });

    try {
        const file = req.file;
        if (!file) return res.status(400).json({ error: "No file uploaded." });

        let targetChannel = GLOBAL_CHANNEL_ID;
        let uploadClient = client;

        // Check if webId was passed (query or body)
        const webId = req.query.webId || req.body.webId;
        if (webId) {
            const db = readDB();
            const web = db.webs.find(w => w.id === webId);
            if (web) {
                if (web.channel) targetChannel = web.channel;
                if (web.session && web.session !== 'main') {
                    uploadClient = await getClientForSession(web.session);
                }
            }
        }

        if (!uploadClient) return res.status(500).json({ error: "Telegram client not connected." });

        console.log(`Uploading ${file.originalname} to channel ${targetChannel}...`);

        const result = await uploadClient.sendFile(targetChannel, {
            file: file.path,
            caption: `Uploaded via Shiv Shakti Server | File: ${file.originalname}`,
            forceDocument: true, 
        });

        const fileSize = file.size || 0;
        fs.unlinkSync(file.path); // Clean up temp file

        const cleanChannelId = targetChannel.toString().replace("-100", "");
        const telegramLink = `https://t.me/c/${cleanChannelId}/${result.id}`;

        // Save metadata to local DB
        const db = readDB();
        const newRecord = {
            id: "rec_" + Date.now(),
            webId: webId || null,
            channelId: targetChannel,
            messageId: result.id,
            mimetype: file.mimetype || "image/jpeg",
            filename: file.originalname,
            size: fileSize,
            telegramLink: telegramLink,
            timestamp: new Date().toISOString()
        };
        db.records.push(newRecord);
        db.stats.outgoingRequests = (db.stats.outgoingRequests || 0) + 1;
        writeDB(db);

        const privateLink = `${req.protocol}://${req.get('host')}/view/${newRecord.id}`;
        res.json({ 
            success: true, 
            recordId: newRecord.id,
            privateLink: privateLink,
            telegramLink: telegramLink
        });

<<<<<<< HEAD
        // Fire-and-forget: generate cache variants in background
        if (file.mimetype && file.mimetype.startsWith('image/')) {
            generateVariants(newRecord, uploadClient).catch(err => {
                console.error(`[Cache] Background variant generation failed:`, err.message);
            });
        }

=======
>>>>>>> 30fc63bc9a83611e1fb74a67f7de335863d9ede7
    } catch (error) {
        console.error("Upload failed:", error);
        res.status(500).json({ error: "Failed to upload to Telegram." });
    }
});

<<<<<<< HEAD
// Serve secure media stream — CACHE-FIRST with quality variants
app.get('/api/image/:recordId', async (req, res) => {
    const { recordId } = req.params;
    const { key, q } = req.query;
=======
// Serve secure media stream from Telegram
app.get('/api/image/:recordId', async (req, res) => {
    const { recordId } = req.params;
    const { key } = req.query;
>>>>>>> 30fc63bc9a83611e1fb74a67f7de335863d9ede7

    if (!recordId || !key) {
        return res.status(400).send("Bad Request: Missing recordId or key parameter.");
    }

<<<<<<< HEAD
    // Determine requested quality (default: mid, ?q=high for full quality)
    const quality = ['thumb', 'low', 'mid', 'high'].includes(q) ? q : 'mid';

=======
>>>>>>> 30fc63bc9a83611e1fb74a67f7de335863d9ede7
    try {
        const db = readDB();
        const record = db.records.find(r => r.id === recordId);
        if (!record) {
            return res.status(404).send("Error: File record not found.");
        }

        // ==========================================================
        // KEY-BASED AUTHENTICATION (More robust, works without webId)
        // ==========================================================
        let web = db.webs.find(w => w.securityKey === key);
        
        // Fallback: if key doesn't match directly, try finding by the record's associated webId
        if (!web && record.webId) {
            web = db.webs.find(w => w.id === record.webId);
        }

        if (!web) {
            return res.status(403).send("Forbidden: Associated Web Connection not found or invalid key.");
        }

        // Security key validation (only if we didn't find the web directly by key)
        if (web.securityKey !== key) {
            return res.status(403).send("Forbidden: Invalid security key.");
        }

        // Domain verification (Referer check)
        if (web.url) {
            const referer = req.headers.referer || req.headers.origin;
            if (referer) {
                try {
                    const urlObj = new URL(web.url);
                    const refObj = new URL(referer);
                    if (urlObj.hostname !== refObj.hostname && refObj.hostname !== 'localhost') {
                        return res.status(403).send("Forbidden: Domain mismatch.");
                    }
                } catch (urlErr) {
                    console.warn("Skipping referer validation due to URL parse issue:", urlErr.message);
                }
            }
        }

<<<<<<< HEAD
        // ============================================
        // CACHE-FIRST SERVING (memory → disk → Telegram)
        // ============================================
        if (serveCachedImageResponse(res, recordId, quality, record.mimetype)) {
            return; // Served from cache in <15ms
        }

        // Cache miss — download from Telegram (slow path, only happens once per image)
        console.log(`[Cache MISS] ${recordId} — downloading from Telegram...`);
        
=======
        // Retrieve Telegram Client for the configured session of this Web Connection
>>>>>>> 30fc63bc9a83611e1fb74a67f7de335863d9ede7
        const uploadClient = await getClientForSession(web.session);
        if (!uploadClient) {
            return res.status(500).send("Error: Telegram client is offline.");
        }

        const targetChannel = record.channelId || GLOBAL_CHANNEL_ID;
        const messageId = parseInt(record.messageId);

<<<<<<< HEAD
=======
        console.log(`Downloading secure image message ${messageId} from channel ${targetChannel}...`);

>>>>>>> 30fc63bc9a83611e1fb74a67f7de335863d9ede7
        const messages = await uploadClient.getMessages(targetChannel, { ids: [messageId] });
        if (!messages || messages.length === 0 || !messages[0].media) {
            return res.status(404).send("Error: Media not found in Telegram channel.");
        }

<<<<<<< HEAD
=======
        // Download media buffer
>>>>>>> 30fc63bc9a83611e1fb74a67f7de335863d9ede7
        const buffer = await uploadClient.downloadMedia(messages[0].media);
        if (!buffer) {
            return res.status(500).send("Error: Failed to stream media from Telegram.");
        }

<<<<<<< HEAD
        // Send the original immediately
        res.setHeader('Content-Type', record.mimetype || 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=604800');
        res.setHeader('X-Cache', 'MISS');
        res.send(buffer);

        // Fire-and-forget: generate all variants for next time
        if (record.mimetype && record.mimetype.startsWith('image/')) {
            generateVariants(record, uploadClient).catch(err => {
                console.error(`[Cache] On-demand variant generation failed:`, err.message);
            });
        }

=======
        // Send file bytes directly to browser
        res.setHeader('Content-Type', record.mimetype || 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 24 hours
        res.send(buffer);

>>>>>>> 30fc63bc9a83611e1fb74a67f7de335863d9ede7
    } catch (err) {
        console.error("Secure image streaming error:", err);
        res.status(500).send("Internal Server Error.");
    }
});

// GET all server logs
app.get('/api/logs', (req, res) => {
    const token = req.headers.authorization;
    if (token !== "admin-auth-token-xyz") return res.status(403).json({ error: "Unauthorized" });

    const db = readDB();
    res.json(db.logs || []);
});

// Clear all server logs
app.post('/api/logs/clear', (req, res) => {
    const token = req.headers.authorization;
    if (token !== "admin-auth-token-xyz") return res.status(403).json({ error: "Unauthorized" });

    const db = readDB();
    db.logs = [];
    writeDB(db, false);
    res.json({ success: true });
});

<<<<<<< HEAD
// Serve private media view page — CACHE-FIRST
app.get('/view/:recordId', async (req, res) => {
    const { recordId } = req.params;
    const { key, q } = req.query;

    const quality = ['thumb', 'low', 'mid', 'high'].includes(q) ? q : 'mid';
=======
// Serve private media view page (looks like not reached if referer or key matches fail)
app.get('/view/:recordId', async (req, res) => {
    const { recordId } = req.params;
    const { key } = req.query;
>>>>>>> 30fc63bc9a83611e1fb74a67f7de335863d9ede7

    try {
        const db = readDB();
        const record = db.records.find(r => r.id === recordId);
        if (!record) {
            return res.status(404).send("Not Found");
        }

        // Find the web connection using the security key provided
        let web = db.webs.find(w => w.securityKey === key);
        
        // Fallback to record's webId
        if (!web && record.webId) {
            web = db.webs.find(w => w.id === record.webId);
        }

        if (!web) {
            return res.status(404).send("Not Found");
        }

        // Validate: either security key matches, OR Referer origin matches
        let isAuthorized = false;
        if (key && web.securityKey === key) {
            isAuthorized = true;
        } else {
            const referer = req.headers.referer || req.headers.origin;
            if (referer && web.url) {
                try {
                    const urlObj = new URL(web.url);
                    const refObj = new URL(referer);
                    if (urlObj.hostname === refObj.hostname || refObj.hostname === 'localhost') {
                        isAuthorized = true;
                    }
                } catch (e) {
                    // Ignore parse issues
                }
            }
        }

        if (!isAuthorized) {
            return res.status(404).send("Not Found");
        }

<<<<<<< HEAD
        // ============================================
        // CACHE-FIRST SERVING (memory → disk → Telegram)
        // ============================================
        if (serveCachedImageResponse(res, recordId, quality, record.mimetype)) {
            return; // Served from cache in <15ms
        }

        // Cache miss — download from Telegram
=======
        // Retrieve Telegram Client for the configured session
>>>>>>> 30fc63bc9a83611e1fb74a67f7de335863d9ede7
        const uploadClient = await getClientForSession(web.session);
        if (!uploadClient) {
            return res.status(500).send("Offline");
        }

        const targetChannel = record.channelId || GLOBAL_CHANNEL_ID;
        const messageId = parseInt(record.messageId);

        const messages = await uploadClient.getMessages(targetChannel, { ids: [messageId] });
        if (!messages || messages.length === 0 || !messages[0].media) {
            return res.status(404).send("Not Found");
        }

        const buffer = await uploadClient.downloadMedia(messages[0].media);
        if (!buffer) {
            return res.status(500).send("Error");
        }

        res.setHeader('Content-Type', record.mimetype || 'image/jpeg');
<<<<<<< HEAD
        res.setHeader('Cache-Control', 'public, max-age=604800');
        res.setHeader('X-Cache', 'MISS');
        res.send(buffer);

        // Fire-and-forget: generate variants for next time
        if (record.mimetype && record.mimetype.startsWith('image/')) {
            generateVariants(record, uploadClient).catch(err => {
                console.error(`[Cache] On-demand variant generation failed:`, err.message);
            });
        }

=======
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.send(buffer);

>>>>>>> 30fc63bc9a83611e1fb74a67f7de335863d9ede7
    } catch (err) {
        console.error("Secure view streaming error:", err);
        res.status(500).send("Error");
    }
});

// ==========================================
// START SERVER
// ==========================================
async function startServer() {
    loadLocalDB();

    if (client) {
        try {
            console.log("Connecting to Telegram...");
            await client.connect();
            console.log("Connected to Telegram!");
            
            // Sync the DB from the Telegram channel
            await syncDatabaseFromTelegram();
<<<<<<< HEAD

            // Pre-warm cache: generate variants for existing records that aren't cached yet
            const db = readDB();
            const uncachedImages = db.records.filter(r => {
                if (!r.mimetype || !r.mimetype.startsWith('image/')) return false;
                const cacheDir = path.join(CACHE_DIR, r.id);
                const midPath = path.join(cacheDir, 'mid.jpg');
                return !fs.existsSync(midPath);
            });

            if (uncachedImages.length > 0) {
                console.log(`[Cache] Pre-warming cache for ${uncachedImages.length} uncached images...`);
                // Process in background, don't block server start
                (async () => {
                    for (const record of uncachedImages) {
                        try {
                            await generateVariants(record, client);
                        } catch (err) {
                            console.error(`[Cache] Pre-warm failed for ${record.id}:`, err.message);
                        }
                    }
                    console.log(`[Cache] Pre-warming complete!`);
                })();
            }
=======
>>>>>>> 30fc63bc9a83611e1fb74a67f7de335863d9ede7
        } catch (err) {
            console.error("\n❌ Telegram Connection Error:", err.message);
            if (err.message.includes("AUTH_KEY_DUPLICATED")) {
                console.error("This means the String Session is being used elsewhere or got corrupted.");
                console.error("Action required: Please generate a new session string and update MAIN_SESSION_STRING in server.js.");
            }
        }
    } else {
        console.warn("WARNING: Telegram client not initialized. Add your session string to test uploads.");
    }
    
    app.listen(PORT, () => {
        console.log(`Server running at http://localhost:${PORT}`);
<<<<<<< HEAD
        console.log(`[Cache] Cache directory: ${CACHE_DIR}`);
        console.log(`[Cache] Memory cache max entries: ${MEMORY_CACHE_MAX}`);
=======
>>>>>>> 30fc63bc9a83611e1fb74a67f7de335863d9ede7
    });
}

startServer();
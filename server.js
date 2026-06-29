const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { ConnectionTCPObfuscated } = require('telegram/network');

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// IMAGE CACHE INFRASTRUCTURE (DISK + MEMORY)
// ==========================================
// Disk cache for image variants (OK if Render wipes it — images re-download from Telegram)
// Memory LRU on top for instant <5ms serving
const CACHE_DIR = path.join(__dirname, 'cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);

// Quality variant definitions
const QUALITY_VARIANTS = {
    thumb: { maxWidth: 400, quality: 20, label: 'Thumbnail ~40-50KB' },
    low:   { maxWidth: 800, quality: 40, label: 'Low ~100KB' },
    mid:   { maxWidth: 1200, quality: 65, label: 'Mid ~200-400KB' },
    high:  { maxWidth: 2000, quality: 85, label: 'High/Original quality' }
};

// In-memory LRU cache for images (max 500 entries — memory only, no disk)
const MEMORY_CACHE_MAX = 500;
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
        const messages = await client.getMessages(GLOBAL_CHANNEL_ID, { limit: 100 });
        
        let configMessage = null;
        const recordChunks = [];

        for (const msg of messages) {
            if (!msg.message) continue;
            if (msg.message.startsWith("#DATABASE_BACKUP#")) {
                configMessage = msg;
            } else if (msg.message.startsWith("#DB_RECORDS_")) {
                // Extract chunk index and data
                const match = msg.message.match(/^#DB_RECORDS_(\d+)#\n(.+)$/s);
                if (match) {
                    recordChunks.push({ index: parseInt(match[1]), data: match[2], id: msg.id });
                }
            }
        }

        if (configMessage) {
            const jsonStr = configMessage.message.replace("#DATABASE_BACKUP#", "").trim();
            cachedDB = JSON.parse(jsonStr);
            
            // Load records from separate chunk messages
            if (recordChunks.length > 0) {
                recordChunks.sort((a, b) => a.index - b.index);
                cachedDB.records = [];
                for (const chunk of recordChunks) {
                    try {
                        const chunkRecords = JSON.parse(chunk.data);
                        // Reconstruct full records from slim format
                        for (const r of chunkRecords) {
                            cachedDB.records.push({
                                id: r.id,
                                webId: r.wId || r.webId || null,
                                channelId: r.ch || r.channelId || GLOBAL_CHANNEL_ID,
                                messageId: r.mId || r.messageId,
                                mimetype: r.mt || r.mimetype || 'image/jpeg',
                                filename: r.fn || r.filename || '',
                                size: r.sz || r.size || 0,
                                telegramLink: '', // Reconstructed on demand
                                timestamp: r.ts || r.timestamp || ''
                            });
                        }
                    } catch (parseErr) {
                        console.error(`Failed to parse record chunk ${chunk.index}:`, parseErr.message);
                    }
                }
            }
            
            fs.writeFileSync(DB_FILE, JSON.stringify(cachedDB, null, 2));
            console.log(`Database synced from Telegram! ${cachedDB.records.length} records loaded.`);
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
        // Separate config (small) from records (can be large)
        const dbConfig = JSON.parse(JSON.stringify(cachedDB));
        const allRecords = dbConfig.records || [];
        delete dbConfig.records; // Remove records from main config
        delete dbConfig.logs;   // Remove logs (too large)
        
        // Save main config message (webs, sessions, stats — always small)
        const configText = `#DATABASE_BACKUP#\n${JSON.stringify(dbConfig)}`;
        const sentConfig = await client.sendMessage(GLOBAL_CHANNEL_ID, { message: configText });
        
        // Split records into chunks that fit within Telegram's 4096 char limit
        const CHUNK_MAX_CHARS = 3800; // Leave room for the tag
        const sentChunkIds = [];
        let currentChunk = [];
        let currentChunkStr = '';
        let chunkIndex = 0;
        
        for (const record of allRecords) {
            // Slim down records for storage (remove reconstructable fields)
            const slim = {
                id: record.id,
                wId: record.webId,
                ch: record.channelId,
                mId: record.messageId,
                mt: record.mimetype,
                fn: record.filename,
                sz: record.size,
                ts: record.timestamp
            };
            
            const testAdd = currentChunk.length === 0 
                ? JSON.stringify([slim]) 
                : JSON.stringify([...currentChunk, slim]);
            
            if (testAdd.length > CHUNK_MAX_CHARS && currentChunk.length > 0) {
                // Send current chunk
                const chunkText = `#DB_RECORDS_${chunkIndex}#\n${JSON.stringify(currentChunk)}`;
                const sent = await client.sendMessage(GLOBAL_CHANNEL_ID, { message: chunkText });
                sentChunkIds.push(sent.id);
                chunkIndex++;
                currentChunk = [slim];
            } else {
                currentChunk.push(slim);
            }
        }
        
        // Send last chunk
        if (currentChunk.length > 0) {
            const chunkText = `#DB_RECORDS_${chunkIndex}#\n${JSON.stringify(currentChunk)}`;
            const sent = await client.sendMessage(GLOBAL_CHANNEL_ID, { message: chunkText });
            sentChunkIds.push(sent.id);
        }
        
        // Delete old backup messages (keep only the ones we just sent)
        const newIds = new Set([sentConfig.id, ...sentChunkIds]);
        const oldMessages = await client.getMessages(GLOBAL_CHANNEL_ID, { limit: 100 });
        const oldToDelete = [];
        for (const msg of oldMessages) {
            if (!msg.message) continue;
            if (newIds.has(msg.id)) continue;
            if (msg.message.startsWith("#DATABASE_BACKUP#") || msg.message.startsWith("#DB_RECORDS_")) {
                oldToDelete.push(msg.id);
            }
        }
        
        if (oldToDelete.length > 0) {
            await client.deleteMessages(GLOBAL_CHANNEL_ID, oldToDelete, { revoke: true });
        }
        
        console.log(`Database backup saved to Telegram! ${allRecords.length} records in ${chunkIndex + 1} chunks.`);
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
        const reqPath = req.path;
        
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
                path: reqPath,
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

// ==========================================
// IMAGE VARIANT GENERATION & CACHE SERVING
// (All in-memory — no disk storage, survives Render restarts via pre-warming)
// ==========================================

/**
 * Generate all quality variants for a record and store in memory cache.
 * Downloads original from Telegram once, generates thumb/low/mid/high in RAM.
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
            const originalPath = path.join(recordCacheDir, 'original');
            fs.writeFileSync(originalPath, originalBuffer);
            memoryCacheSet(`${recordId}:original`, originalBuffer);
            console.log(`[Cache] Non-image file cached for ${recordId}`);
            generatingVariants.delete(recordId);
            return;
        }

        // Generate each variant in memory (thumb first — smallest, fastest)
        const variantOrder = ['thumb', 'low', 'mid', 'high'];
        for (const variant of variantOrder) {
            try {
                const config = QUALITY_VARIANTS[variant];

                const outputPath = path.join(recordCacheDir, `${variant}.jpg`);

                const variantBuffer = await sharp(originalBuffer)
                    .resize({ width: config.maxWidth, withoutEnlargement: true })
                    .jpeg({ quality: config.quality, mozjpeg: true })
                    .toBuffer();

                // Save to disk + memory
                fs.writeFileSync(outputPath, variantBuffer);
                memoryCacheSet(`${recordId}:${variant}`, variantBuffer);
                console.log(`[Cache] ${recordId}:${variant} → ${(variantBuffer.length / 1024).toFixed(1)}KB`);
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
 * Get the best available cached variant for a record from memory.
 * @param {string} recordId
 * @param {string} quality - 'thumb', 'low', 'mid', 'high'
 * @returns {Buffer|null}
 */
function getCachedImage(recordId, quality = 'mid') {
    const cacheKey = `${recordId}:${quality}`;

    // 1. Check memory LRU cache (fastest, <1ms)
    const memBuf = memoryCacheGet(cacheKey);
    if (memBuf) return { buffer: memBuf, actualQuality: quality };

    // 2. Check disk cache (still fast, <15ms)
    const filePath = path.join(CACHE_DIR, recordId, `${quality}.jpg`);
    if (fs.existsSync(filePath)) {
        const diskBuf = fs.readFileSync(filePath);
        memoryCacheSet(cacheKey, diskBuf); // Promote to memory
        return { buffer: diskBuf, actualQuality: quality };
    }

    // 3. Fallback: try other quality variants (memory then disk)
    const fallbackOrder = ['thumb', 'low', 'mid', 'high'];
    for (const fallback of fallbackOrder) {
        if (fallback === quality) continue;
        const fallbackMemBuf = memoryCacheGet(`${recordId}:${fallback}`);
        if (fallbackMemBuf) return { buffer: fallbackMemBuf, actualQuality: fallback };
        const fallbackDiskPath = path.join(CACHE_DIR, recordId, `${fallback}.jpg`);
        if (fs.existsSync(fallbackDiskPath)) {
            const fallbackDiskBuf = fs.readFileSync(fallbackDiskPath);
            memoryCacheSet(`${recordId}:${fallback}`, fallbackDiskBuf);
            return { buffer: fallbackDiskBuf, actualQuality: fallback };
        }
    }

    return null; // Cache miss — need to download from Telegram
}

/**
 * Serve a cached image with proper headers.
 * Returns true if served from cache, false if cache miss.
 */
function serveCachedImageResponse(res, recordId, quality) {
    const cached = getCachedImage(recordId, quality);
    if (cached) {
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Content-Length', cached.buffer.length);
        res.setHeader('Cache-Control', 'public, max-age=604800'); // 7 days browser cache
        res.setHeader('X-Cache', 'HIT');
        res.setHeader('X-Quality', cached.actualQuality);
        res.send(cached.buffer);
        return true;
    }
    return false;
}

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

        // Fire-and-forget: generate cache variants in background (stored in memory)
        if (file.mimetype && file.mimetype.startsWith('image/')) {
            generateVariants(newRecord, uploadClient).catch(err => {
                console.error(`[Cache] Background variant generation failed:`, err.message);
            });
        }

    } catch (error) {
        console.error("Upload failed:", error);
        res.status(500).json({ error: "Failed to upload to Telegram." });
    }
});

// Serve secure media stream — CACHE-FIRST with quality variants
app.get('/api/image/:recordId', async (req, res) => {
    const { recordId } = req.params;
    const { key, q } = req.query;

    if (!recordId || !key) {
        return res.status(400).send("Bad Request: Missing recordId or key parameter.");
    }

    // Determine requested quality (default: mid, ?q=high for full quality)
    const quality = ['thumb', 'low', 'mid', 'high'].includes(q) ? q : 'mid';

    try {
        const db = readDB();
        let record = db.records.find(r => r.id === recordId);
        
        // --- FUZZY MATCH FALLBACK FOR RECOVERED RECORDS ---
        // If the record isn't found by exact ID, but looks like an old timestamp ID...
        if (!record && recordId.startsWith('rec_') && !recordId.startsWith('rec_tg_')) {
            const requestedTs = parseInt(recordId.replace('rec_', ''));
            if (!isNaN(requestedTs)) {
                let closest = null;
                let minDiff = 60000; // Search within 60 seconds
                for (const r of db.records) {
                    if (!r.timestamp) continue;
                    const rTs = new Date(r.timestamp).getTime();
                    const diff = Math.abs(rTs - requestedTs);
                    if (diff < minDiff) {
                        minDiff = diff;
                        closest = r;
                    }
                }
                if (closest) {
                    // Temporarily use this closest record to serve the image
                    // This permanently fixes the broken URL!
                    record = closest;
                }
            }
        }
        // --------------------------------------------------

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

        // ============================================
        // CACHE-FIRST SERVING (memory only → Telegram fallback)
        // ============================================
        if (serveCachedImageResponse(res, recordId, quality)) {
            return; // Served from memory cache in <5ms
        }

        // Cache miss — download from Telegram (slow path, only happens once per image after restart)
        console.log(`[Cache MISS] ${recordId} — downloading from Telegram...`);
        
        const uploadClient = await getClientForSession(web.session);
        if (!uploadClient) {
            return res.status(500).send("Error: Telegram client is offline.");
        }

        const targetChannel = record.channelId || GLOBAL_CHANNEL_ID;
        const messageId = parseInt(record.messageId);

        const messages = await uploadClient.getMessages(targetChannel, { ids: [messageId] });
        if (!messages || messages.length === 0 || !messages[0].media) {
            return res.status(404).send("Error: Media not found in Telegram channel.");
        }

        const buffer = await uploadClient.downloadMedia(messages[0].media);
        if (!buffer) {
            return res.status(500).send("Error: Failed to stream media from Telegram.");
        }

        // Send the original immediately
        res.setHeader('Content-Type', record.mimetype || 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=604800');
        res.setHeader('X-Cache', 'MISS');
        res.send(buffer);

        // Fire-and-forget: generate all variants in memory for next time
        if (record.mimetype && record.mimetype.startsWith('image/')) {
            generateVariants(record, uploadClient).catch(err => {
                console.error(`[Cache] On-demand variant generation failed:`, err.message);
            });
        }

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

// Serve private media view page — CACHE-FIRST
app.get('/view/:recordId', async (req, res) => {
    const { recordId } = req.params;
    const { key, q } = req.query;

    const quality = ['thumb', 'low', 'mid', 'high'].includes(q) ? q : 'mid';

    try {
        const db = readDB();
        let record = db.records.find(r => r.id === recordId);
        
        // --- FUZZY MATCH FALLBACK FOR RECOVERED RECORDS ---
        if (!record && recordId.startsWith('rec_') && !recordId.startsWith('rec_tg_')) {
            const requestedTs = parseInt(recordId.replace('rec_', ''));
            if (!isNaN(requestedTs)) {
                let closest = null;
                let minDiff = 60000;
                for (const r of db.records) {
                    if (!r.timestamp) continue;
                    const rTs = new Date(r.timestamp).getTime();
                    const diff = Math.abs(rTs - requestedTs);
                    if (diff < minDiff) {
                        minDiff = diff;
                        closest = r;
                    }
                }
                if (closest) record = closest;
            }
        }
        // --------------------------------------------------

        if (!record) {
            return res.status(404).send("Not Found");
        }

        // Find the web connection using the security key provided
        let web = db.webs.find(w => w.securityKey === key);
        
        // Fallback 1: record's webId
        if (!web && record.webId) {
            web = db.webs.find(w => w.id === record.webId);
        }

        let isAuthorized = false;

        // Fallback 2: If we still don't have a web connection (e.g. for recovered records where webId is null),
        // we can check if the Referer header matches ANY of our registered web connections.
        const referer = req.headers.referer || req.headers.origin;
        if (!web && referer) {
            for (const w of db.webs) {
                if (w.url) {
                    try {
                        const urlObj = new URL(w.url);
                        const refObj = new URL(referer);
                        if (urlObj.hostname === refObj.hostname || refObj.hostname === 'localhost') {
                            web = w; // Found a matching web connection!
                            isAuthorized = true;
                            break;
                        }
                    } catch (e) {}
                }
            }
        }

        if (!web) {
            return res.status(404).send("Not Found");
        }

        // Validate: either security key matches, OR Referer origin matches (if not already authorized by Fallback 2)
        if (!isAuthorized) {
            if (key && web.securityKey === key) {
                isAuthorized = true;
            } else if (referer && web.url) {
                try {
                    const urlObj = new URL(web.url);
                    const refObj = new URL(referer);
                    if (urlObj.hostname === refObj.hostname || refObj.hostname === 'localhost') {
                        isAuthorized = true;
                    }
                } catch (e) {}
            }
        }

        if (!isAuthorized) {
            return res.status(404).send("Not Found");
        }

        // ============================================
        // CACHE-FIRST SERVING (memory only → Telegram fallback)
        // ============================================
        if (serveCachedImageResponse(res, recordId, quality)) {
            return; // Served from memory cache in <5ms
        }

        // Cache miss — download from Telegram
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
        res.setHeader('Cache-Control', 'public, max-age=604800');
        res.setHeader('X-Cache', 'MISS');
        res.send(buffer);

        // Fire-and-forget: generate variants in memory for next time
        if (record.mimetype && record.mimetype.startsWith('image/')) {
            generateVariants(record, uploadClient).catch(err => {
                console.error(`[Cache] On-demand variant generation failed:`, err.message);
            });
        }

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

            // Pre-warm memory cache: generate variants for existing image records
            const db = readDB();
            const imageRecords = db.records.filter(r => r.mimetype && r.mimetype.startsWith('image/'));

            if (imageRecords.length > 0) {
                // Only pre-warm images not already cached on disk
                const uncached = imageRecords.filter(r => {
                    const midPath = path.join(CACHE_DIR, r.id, 'mid.jpg');
                    return !fs.existsSync(midPath);
                });
                if (uncached.length > 0) {
                    console.log(`[Cache] Pre-warming cache for ${uncached.length} uncached images...`);
                }
                // Process in background, don't block server start
                (async () => {
                    for (const record of uncached) {
                        try {
                            await generateVariants(record, client);
                        } catch (err) {
                            console.error(`[Cache] Pre-warm failed for ${record.id}:`, err.message);
                        }
                    }
                    if (uncached.length > 0) console.log(`[Cache] Pre-warming complete! ${memoryCache.size} memory entries.`);
                })();
            }
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
        console.log(`[Cache] Disk cache: ${CACHE_DIR} | Memory LRU: max ${MEMORY_CACHE_MAX} entries`);
    });
}

startServer();
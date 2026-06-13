const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { ConnectionTCPObfuscated } = require('telegram/network');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
// Serve the frontend files from the "public" directory
app.use(express.static('public'));

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

function writeDB(data) {
    cachedDB = data;
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(cachedDB, null, 2));
        saveDatabaseToTelegram().catch(err => console.error("Async Telegram sync failed:", err));
    } catch (err) {
        console.error("DB Write Error", err);
    }
}

// Track incoming requests and capture request/response logs middleware
app.use((req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/view')) {
        const db = readDB();
        db.stats.incomingRequests = (db.stats.incomingRequests || 0) + 1;
        writeDB(db);

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

            writeDB(currentDb);
            
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

    } catch (error) {
        console.error("Upload failed:", error);
        res.status(500).json({ error: "Failed to upload to Telegram." });
    }
});

// Serve secure media stream from Telegram
app.get('/api/image/:recordId', async (req, res) => {
    const { recordId } = req.params;
    const { key } = req.query;

    if (!recordId || !key) {
        return res.status(400).send("Bad Request: Missing recordId or key parameter.");
    }

    try {
        const db = readDB();
        const record = db.records.find(r => r.id === recordId);
        if (!record) {
            return res.status(404).send("Error: File record not found.");
        }

        // Validate web ID linkage
        if (!record.webId) {
            return res.status(403).send("Forbidden: This file is not associated with any Web Connection.");
        }

        const web = db.webs.find(w => w.id === record.webId);
        if (!web) {
            return res.status(403).send("Forbidden: The associated Web Connection no longer exists.");
        }

        // Security key validation
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

        // Retrieve Telegram Client for the configured session of this Web Connection
        const uploadClient = await getClientForSession(web.session);
        if (!uploadClient) {
            return res.status(500).send("Error: Telegram client is offline.");
        }

        const targetChannel = record.channelId || GLOBAL_CHANNEL_ID;
        const messageId = parseInt(record.messageId);

        console.log(`Downloading secure image message ${messageId} from channel ${targetChannel}...`);

        const messages = await uploadClient.getMessages(targetChannel, { ids: [messageId] });
        if (!messages || messages.length === 0 || !messages[0].media) {
            return res.status(404).send("Error: Media not found in Telegram channel.");
        }

        // Download media buffer
        const buffer = await uploadClient.downloadMedia(messages[0].media);
        if (!buffer) {
            return res.status(500).send("Error: Failed to stream media from Telegram.");
        }

        // Send file bytes directly to browser
        res.setHeader('Content-Type', record.mimetype || 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 24 hours
        res.send(buffer);

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
    writeDB(db);
    res.json({ success: true });
});

// Serve private media view page (looks like not reached if referer or key matches fail)
app.get('/view/:recordId', async (req, res) => {
    const { recordId } = req.params;
    const { key } = req.query;

    try {
        const db = readDB();
        const record = db.records.find(r => r.id === recordId);
        if (!record) {
            return res.status(404).send("Not Found");
        }

        // Must be associated with a web connection
        if (!record.webId) {
            return res.status(404).send("Not Found");
        }

        const web = db.webs.find(w => w.id === record.webId);
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

        // Retrieve Telegram Client for the configured session
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
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.send(buffer);

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
    });
}

startServer();
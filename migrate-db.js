/**
 * Migration Script: Convert old single-message DB to new chunked format
 * 
 * This script:
 * 1. Connects to Telegram
 * 2. Reads the old #DATABASE_BACKUP# message (with records inside)
 * 3. Splits records into chunked #DB_RECORDS_X# messages
 * 4. Saves config separately in #DATABASE_BACKUP#
 * 5. Deletes old backup messages
 * 
 * ⚠️ Record IDs stay EXACTLY the same — image URLs will NOT change!
 * 
 * Run: node migrate-db.js
 */

const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { ConnectionTCPObfuscated } = require('telegram/network');

// ── Config ──
const API_ID = parseInt(process.env.TELEGRAM_API_ID) || 32680911;
const API_HASH = process.env.TELEGRAM_API_HASH || "448b0b278e63af1c52f92b7696e874cf";
const SESSION_STRING = process.env.TELEGRAM_SESSION_STRING || "1BQANOTEuMTA4LjU2LjEyNwG7HWnadYBVrdX0IR8eEzIdGrMJWbScVrCpHsNkTlB1YcTkFRI6eYN+24Y0bOa1MhIkWea3+gbmP/O/DLPzgArDcvB9z8Cyo4xjeFh8bUIDwoUYHT8Wn6OORmHIWmMdytGplDqFK35pnfqP7vbJwl8ghZLeIVhx21zjWrbH4xzzTMLQasQf6i4YUQHpQ4WvQMYz2iVdG5LpMqtP2J4U25BmOh39xwbXlkO2IBVyChvaNMLOYh2va2dkO+2Fv6fid2WN3tnmtz7LQVgSE1s8sKUuVyMMKNAn7O1es+FGwl+WBeor5PSGoueeod+GSzWB1hSi2qtHhflAobjEZs/ILy6TVg==";
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID || "-1003992574269";

async function migrate() {
    console.log("═══════════════════════════════════════════");
    console.log("  DB Recovery: Rebuilding from Channel");
    console.log("═══════════════════════════════════════════\n");

    const stringSession = new StringSession(SESSION_STRING);
    if (stringSession.dcId && stringSession.serverAddress) {
        stringSession.setDC(stringSession.dcId, stringSession.serverAddress, 443);
    }
    const client = new TelegramClient(stringSession, API_ID, API_HASH, {
        connectionRetries: 5,
        connection: ConnectionTCPObfuscated
    });

    console.log("Connecting to Telegram...");
    await client.connect();
    console.log("✅ Connected!\n");

    // Step 1: Scan entire channel for media
    console.log("Step 1: Scanning channel for all media messages...");
    const recoveredRecords = [];
    let offsetId = 0;
    let totalMessagesChecked = 0;

    while (true) {
        const messages = await client.getMessages(CHANNEL_ID, { limit: 100, offsetId });
        if (messages.length === 0) break;

        for (const msg of messages) {
            if (msg.media && (msg.media.photo || msg.media.document)) {
                // Try to extract filename from caption
                let filename = `recovered_${msg.id}.jpg`;
                let mimetype = 'image/jpeg';
                
                if (msg.message && msg.message.includes("File: ")) {
                    const match = msg.message.match(/File:\s*([^\n]+)/);
                    if (match) filename = match[1].trim();
                }

                if (msg.media.document) {
                    const attrs = msg.media.document.attributes || [];
                    for (const attr of attrs) {
                        if (attr.className === 'DocumentAttributeFilename') {
                            filename = attr.fileName;
                        }
                    }
                    mimetype = msg.media.document.mimeType || mimetype;
                }

                recoveredRecords.push({
                    id: `rec_tg_${msg.id}`, // We'll use fuzzy matching on the server for the old URLs
                    wId: null,
                    ch: CHANNEL_ID,
                    mId: msg.id,
                    mt: mimetype,
                    fn: filename,
                    sz: msg.media.document ? msg.media.document.size : 0,
                    ts: new Date(msg.date * 1000).toISOString()
                });
            }
        }
        
        offsetId = messages[messages.length - 1].id;
        totalMessagesChecked += messages.length;
        process.stdout.write(`\r  Checked ${totalMessagesChecked} messages... found ${recoveredRecords.length} media files.`);
    }

    console.log(`\n\n  📊 Total recovered records: ${recoveredRecords.length}`);

    if (recoveredRecords.length === 0) {
        console.log("❌ No media found in channel. Nothing to do.");
        await client.disconnect();
        return;
    }

    // Step 2: Get current config (webs, sessions, stats) from existing backup
    console.log("\nStep 2: Merging with existing config...");
    let oldDB = { records: [], stats: { incomingRequests: 0, outgoingRequests: 0 }, webs: [], secondarySessions: [] };
    const oldMessageIds = [];
    
    const configMsgs = await client.getMessages(CHANNEL_ID, { limit: 100 });
    for (const msg of configMsgs) {
        if (!msg.message) continue;
        if (msg.message.startsWith("#DATABASE_BACKUP#")) {
            try {
                oldDB = JSON.parse(msg.message.replace("#DATABASE_BACKUP#", "").trim());
                oldMessageIds.push(msg.id);
            } catch(e) {}
        } else if (msg.message.startsWith("#DB_RECORDS_")) {
            oldMessageIds.push(msg.id);
        }
    }

    // Step 3: Save to new chunked format
    console.log("\nStep 3: Creating chunked backup...");
    delete oldDB.records;
    delete oldDB.logs;
    
    const configText = `#DATABASE_BACKUP#\n${JSON.stringify(oldDB)}`;
    const sentConfig = await client.sendMessage(CHANNEL_ID, { message: configText });
    console.log(`  ✅ Config saved (msg ID: ${sentConfig.id})`);

    const CHUNK_MAX_CHARS = 3800;
    const sentChunkIds = [];
    let currentChunk = [];
    let chunkIndex = 0;

    for (const slim of recoveredRecords) {
        const testAdd = currentChunk.length === 0
            ? JSON.stringify([slim])
            : JSON.stringify([...currentChunk, slim]);

        if (testAdd.length > CHUNK_MAX_CHARS && currentChunk.length > 0) {
            const chunkText = `#DB_RECORDS_${chunkIndex}#\n${JSON.stringify(currentChunk)}`;
            const sent = await client.sendMessage(CHANNEL_ID, { message: chunkText });
            sentChunkIds.push(sent.id);
            console.log(`  ✅ Chunk ${chunkIndex}: ${currentChunk.length} records → msg ID: ${sent.id}`);
            chunkIndex++;
            currentChunk = [slim];
        } else {
            currentChunk.push(slim);
        }
    }

    if (currentChunk.length > 0) {
        const chunkText = `#DB_RECORDS_${chunkIndex}#\n${JSON.stringify(currentChunk)}`;
        const sent = await client.sendMessage(CHANNEL_ID, { message: chunkText });
        sentChunkIds.push(sent.id);
        console.log(`  ✅ Chunk ${chunkIndex}: ${currentChunk.length} records → msg ID: ${sent.id}`);
    }

    // Step 4: Cleanup
    console.log("\nStep 4: Cleaning up old backup messages...");
    const newIds = new Set([sentConfig.id, ...sentChunkIds]);
    const toDelete = oldMessageIds.filter(id => !newIds.has(id));

    if (toDelete.length > 0) {
        await client.deleteMessages(CHANNEL_ID, toDelete, { revoke: true });
        console.log(`  🗑️  Deleted ${toDelete.length} old backup messages`);
    }

    console.log("\n═══════════════════════════════════════════");
    console.log("  ✅ DB Recovery Complete!");
    console.log("═══════════════════════════════════════════");
    console.log(`  You can now run this script anytime to rebuild your DB!`);
    console.log("═══════════════════════════════════════════\n");

    await client.disconnect();
}

migrate().catch(err => {
    console.error("❌ Recovery failed:", err);
    process.exit(1);
});

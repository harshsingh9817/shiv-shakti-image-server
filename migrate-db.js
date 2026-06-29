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

// ── Config (same as server.js) ──
const API_ID = parseInt(process.env.TELEGRAM_API_ID) || 32680911;
const API_HASH = process.env.TELEGRAM_API_HASH || "448b0b278e63af1c52f92b7696e874cf";
const SESSION_STRING = process.env.TELEGRAM_SESSION_STRING || "1BQANOTEuMTA4LjU2LjEyNwG7HWnadYBVrdX0IR8eEzIdGrMJWbScVrCpHsNkTlB1YcTkFRI6eYN+24Y0bOa1MhIkWea3+gbmP/O/DLPzgArDcvB9z8Cyo4xjeFh8bUIDwoUYHT8Wn6OORmHIWmMdytGplDqFK35pnfqP7vbJwl8ghZLeIVhx21zjWrbH4xzzTMLQasQf6i4YUQHpQ4WvQMYz2iVdG5LpMqtP2J4U25BmOh39xwbXlkO2IBVyChvaNMLOYh2va2dkO+2Fv6fid2WN3tnmtz7LQVgSE1s8sKUuVyMMKNAn7O1es+FGwl+WBeor5PSGoueeod+GSzWB1hSi2qtHhflAobjEZs/ILy6TVg==";
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID || "-1003992574269";

async function migrate() {
    console.log("═══════════════════════════════════════════");
    console.log("  DB Migration: Single Message → Chunked");
    console.log("═══════════════════════════════════════════\n");

    // Connect to Telegram
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

    // Step 1: Read ALL existing backup messages
    console.log("Step 1: Reading existing backup messages...");
    const messages = await client.getMessages(CHANNEL_ID, { limit: 100 });

    let oldDB = null;
    const oldMessageIds = [];

    for (const msg of messages) {
        if (!msg.message) continue;

        if (msg.message.startsWith("#DATABASE_BACKUP#")) {
            if (!oldDB) {
                try {
                    const jsonStr = msg.message.replace("#DATABASE_BACKUP#", "").trim();
                    oldDB = JSON.parse(jsonStr);
                    console.log(`  Found old backup (msg ID: ${msg.id})`);
                } catch (e) {
                    console.log(`  Found backup msg but failed to parse: ${e.message}`);
                }
            }
            oldMessageIds.push(msg.id);
        }

        if (msg.message.startsWith("#DB_RECORDS_")) {
            oldMessageIds.push(msg.id);
        }
    }

    if (!oldDB) {
        console.log("❌ No existing #DATABASE_BACKUP# found in channel. Nothing to migrate.");
        await client.disconnect();
        return;
    }

    const records = oldDB.records || [];
    console.log(`\n  📊 Found ${records.length} records`);
    console.log(`  📊 Found ${(oldDB.webs || []).length} web connections`);
    console.log(`  📊 Found ${(oldDB.secondarySessions || []).length} secondary sessions`);

    // Step 2: Show all record IDs (proof they won't change)
    console.log("\nStep 2: Verifying record IDs (these will NOT change)...");
    for (const r of records) {
        console.log(`  ✓ ${r.id} → msgId:${r.messageId} (${r.filename || 'unknown'})`);
    }

    // Step 3: Create new chunked format
    console.log("\nStep 3: Creating new chunked backup...");

    // Config message (everything except records and logs)
    const dbConfig = JSON.parse(JSON.stringify(oldDB));
    delete dbConfig.records;
    delete dbConfig.logs;

    const configText = `#DATABASE_BACKUP#\n${JSON.stringify(dbConfig)}`;
    console.log(`  Config message: ${configText.length} chars`);

    const sentConfig = await client.sendMessage(CHANNEL_ID, { message: configText });
    console.log(`  ✅ Config saved (msg ID: ${sentConfig.id})`);

    // Split records into chunks
    const CHUNK_MAX_CHARS = 3800;
    const sentChunkIds = [];
    let currentChunk = [];
    let chunkIndex = 0;
    let totalSlimmed = 0;

    for (const record of records) {
        // Slim down but keep the SAME id
        const slim = {
            id: record.id,           // ← SAME ID, URLs don't change
            wId: record.webId,
            ch: record.channelId,
            mId: record.messageId,
            mt: record.mimetype,
            fn: record.filename,
            sz: record.size,
            ts: record.timestamp
        };
        totalSlimmed++;

        const testAdd = currentChunk.length === 0
            ? JSON.stringify([slim])
            : JSON.stringify([...currentChunk, slim]);

        if (testAdd.length > CHUNK_MAX_CHARS && currentChunk.length > 0) {
            // Send current chunk
            const chunkText = `#DB_RECORDS_${chunkIndex}#\n${JSON.stringify(currentChunk)}`;
            const sent = await client.sendMessage(CHANNEL_ID, { message: chunkText });
            sentChunkIds.push(sent.id);
            console.log(`  ✅ Chunk ${chunkIndex}: ${currentChunk.length} records (${chunkText.length} chars) → msg ID: ${sent.id}`);
            chunkIndex++;
            currentChunk = [slim];
        } else {
            currentChunk.push(slim);
        }
    }

    // Send last chunk
    if (currentChunk.length > 0) {
        const chunkText = `#DB_RECORDS_${chunkIndex}#\n${JSON.stringify(currentChunk)}`;
        const sent = await client.sendMessage(CHANNEL_ID, { message: chunkText });
        sentChunkIds.push(sent.id);
        console.log(`  ✅ Chunk ${chunkIndex}: ${currentChunk.length} records (${chunkText.length} chars) → msg ID: ${sent.id}`);
    }

    // Step 4: Delete old messages
    console.log("\nStep 4: Cleaning up old backup messages...");
    const newIds = new Set([sentConfig.id, ...sentChunkIds]);
    const toDelete = oldMessageIds.filter(id => !newIds.has(id));

    if (toDelete.length > 0) {
        await client.deleteMessages(CHANNEL_ID, toDelete, { revoke: true });
        console.log(`  🗑️  Deleted ${toDelete.length} old backup messages`);
    } else {
        console.log(`  No old messages to delete`);
    }

    // Done!
    console.log("\n═══════════════════════════════════════════");
    console.log("  ✅ Migration Complete!");
    console.log("═══════════════════════════════════════════");
    console.log(`  Records migrated: ${totalSlimmed}`);
    console.log(`  Chunks created: ${chunkIndex + 1}`);
    console.log(`  Record IDs: UNCHANGED ✓`);
    console.log(`  Image URLs: UNCHANGED ✓`);
    console.log("\n  You can now deploy the updated server.js to Render.");
    console.log("═══════════════════════════════════════════\n");

    await client.disconnect();
}

migrate().catch(err => {
    console.error("❌ Migration failed:", err);
    process.exit(1);
});

require('dotenv').config();
const express = require('express');
const http = require('http');
const { createClient } = require('@libsql/client');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// --- FIX: Clean the URL and check Token ---
let dbUrl = (process.env.TURSO_DATABASE_URL || "").trim();
if (dbUrl.endsWith('/')) dbUrl = dbUrl.slice(0, -1); // Remove trailing slash

const dbToken = (process.env.TURSO_AUTH_TOKEN || "").trim();

if (!dbUrl || !dbToken) {
    console.error("❌ CRITICAL ERROR: TURSO_DATABASE_URL or TURSO_AUTH_TOKEN is missing!");
    process.exit(1);
}

const db = createClient({
    url: dbUrl,
    authToken: dbToken,
});

const format = (row) => {
    if (!row) return null;
    return { ...row, _id: row.id ? row.id.toString() : null }; 
};

async function startServer() {
    try {
        console.log("⏳ Connecting to Turso at:", dbUrl);
        
        // Simple test query to verify connection before running tables
        await db.execute("SELECT 1");
        console.log("📡 Turso Connection Verified");

        await db.execute(`CREATE TABLE IF NOT EXISTS players (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, strength INTEGER, cardType TEXT, status TEXT, baseValue INTEGER, soldTo TEXT)`);
        await db.execute(`CREATE TABLE IF NOT EXISTS teams (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, captainEmail TEXT, budget INTEGER)`);
        await db.execute(`CREATE TABLE IF NOT EXISTS auction_state (id INTEGER PRIMARY KEY, activePlayerId INTEGER, currentBid INTEGER, highestBidder TEXT)`);
        await db.execute(`CREATE TABLE IF NOT EXISTS chats (id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT, role TEXT, text TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)`);
        
        await db.execute(`INSERT OR IGNORE INTO auction_state (id, activePlayerId, currentBid, highestBidder) VALUES (1, NULL, 0, NULL)`);

        const teams = [
            ["Team SHAKTI", "avirup@nexus.com", 1000],
            ["Aura Farmer's", "gourav@nexus.com", 1000],
            ["Archmage", "aviroop@nexus.com", 1000],
            ["Shadow Raze", "bishal@nexus.com", 1000],
            ["RISING FALCONS", "abhisek@nexus.com", 1000],
            ["Golden Knights FC", "sanju@nexus.com", 1000]
        ];
        
        for (const [name, email, budget] of teams) {
            await db.execute({
                sql: "INSERT OR IGNORE INTO teams (name, captainEmail, budget) VALUES (?, ?, ?)",
                args: [name, email, budget]
            });
        }
        
        console.log("✅ Database Schema Ready");

        const PORT = process.env.PORT || 3000;
        server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

    } catch (err) {
        console.error("❌ Failed to start server:", err.message);
        // Don't kill the process on Render if it's just a transient DB error
        setTimeout(startServer, 5000); 
    }
}

// Routes and Socket logic remain the same
app.get('/', (req, res) => res.send("Auction Server Alive"));

io.on('connection', async (socket) => {
    const refresh = async () => {
        try {
            const p = await db.execute("SELECT * FROM players");
            const t = await db.execute("SELECT * FROM teams");
            const c = await db.execute("SELECT * FROM chats ORDER BY id DESC LIMIT 50");
            const sRes = await db.execute("SELECT * FROM auction_state WHERE id = 1");
            let state = sRes.rows[0];
            if (state && state.activePlayerId) {
                const activeP = await db.execute({ sql: "SELECT * FROM players WHERE id = ?", args: [state.activePlayerId] });
                state.activePlayerId = format(activeP.rows[0]);
            }
            socket.emit('initialData', { players: p.rows.map(format), teams: t.rows.map(format), state, chats: c.rows.map(format).reverse() });
        } catch (e) { console.error(e); }
    };
    await refresh();

    socket.on('addPlayer', async (data) => {
        await db.execute({ sql: "INSERT INTO players (name, strength, cardType, baseValue, status, soldTo) VALUES (?, ?, ?, ?, 'Available', '-')", args: [data.name, data.strength, data.cardType, data.baseValue] });
        io.emit('updatePlayers', (await db.execute("SELECT * FROM players")).rows.map(format));
    });

    socket.on('startAuction', async ({ playerId, baseValue }) => {
        await db.execute({ sql: "UPDATE auction_state SET activePlayerId = ?, currentBid = ?, highestBidder = NULL WHERE id = 1", args: [playerId, baseValue] });
        const s = (await db.execute("SELECT * FROM auction_state WHERE id = 1")).rows[0];
        const p = (await db.execute({ sql: "SELECT * FROM players WHERE id = ?", args: [playerId] })).rows[0];
        io.emit('updateAuction', { ...s, activePlayerId: format(p) });
    });

    socket.on('placeBid', async ({ teamName, increment }) => {
        const state = (await db.execute("SELECT * FROM auction_state WHERE id = 1")).rows[0];
        const team = (await db.execute({ sql: "SELECT * FROM teams WHERE name = ?", args: [teamName] })).rows[0];
        const newBid = state.currentBid + increment;
        if (team && team.budget >= newBid) {
            await db.execute({ sql: "UPDATE auction_state SET currentBid = ?, highestBidder = ? WHERE id = 1", args: [newBid, teamName] });
            const updS = (await db.execute("SELECT * FROM auction_state WHERE id = 1")).rows[0];
            const p = (await db.execute({ sql: "SELECT * FROM players WHERE id = ?", args: [state.activePlayerId] })).rows[0];
            io.emit('updateAuction', { ...updS, activePlayerId: format(p) });
        }
    });

    socket.on('sellPlayer', async () => {
        const state = (await db.execute("SELECT * FROM auction_state WHERE id = 1")).rows[0];
        if (state.activePlayerId && state.highestBidder) {
            await db.execute({ sql: "UPDATE teams SET budget = budget - ? WHERE name = ?", args: [state.currentBid, state.highestBidder] });
            await db.execute({ sql: "UPDATE players SET status = 'Sold', soldTo = ? WHERE id = ?", args: [`${state.highestBidder} (${state.currentBid}L)`, state.activePlayerId] });
            await db.execute("UPDATE auction_state SET activePlayerId = NULL, currentBid = 0, highestBidder = NULL WHERE id = 1");
            io.emit('updatePlayers', (await db.execute("SELECT * FROM players")).rows.map(format));
            io.emit('updateTeams', (await db.execute("SELECT * FROM teams")).rows.map(format));
            io.emit('updateAuction', { activePlayerId: null });
        }
    });

    socket.on('sendMessage', async (d) => {
        const res = await db.execute({ sql: "INSERT INTO chats (sender, role, text) VALUES (?, ?, ?) RETURNING *", args: [d.sender, d.role, d.text] });
        io.emit('newMessage', format(res.rows[0]));
    });

    socket.on('deletePlayer', async (id) => {
        await db.execute({ sql: "DELETE FROM players WHERE id = ?", args: [id] });
        io.emit('updatePlayers', (await db.execute("SELECT * FROM players")).rows.map(format));
    });
});

startServer();

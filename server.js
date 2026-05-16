require('dotenv').config();
const express = require('express');
const http = require('http');
const { createClient } = require('@libsql/client');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// --- TURSO CONNECTION ---
const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// --- DATABASE INITIALIZATION (Tables) ---
async function initDb() {
    // Players Table
    await db.execute(`CREATE TABLE IF NOT EXISTS players (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        strength INTEGER,
        cardType TEXT,
        status TEXT DEFAULT 'Available',
        baseValue INTEGER,
        soldTo TEXT DEFAULT '-'
    )`);

    // Teams Table
    await db.execute(`CREATE TABLE IF NOT EXISTS teams (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE,
        captainEmail TEXT,
        budget INTEGER
    )`);

    // Auction State Table (Single Row)
    await db.execute(`CREATE TABLE IF NOT EXISTS auction_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        activePlayerId INTEGER,
        currentBid INTEGER DEFAULT 0,
        highestBidder TEXT
    )`);

    // Chats Table
    await db.execute(`CREATE TABLE IF NOT EXISTS chats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender TEXT,
        role TEXT,
        text TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Insert Default Auction State
    await db.execute(`INSERT OR IGNORE INTO auction_state (id, activePlayerId, currentBid, highestBidder) VALUES (1, NULL, 0, NULL)`);

    // Seed Teams
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
    console.log("✅ Turso SQLite Tables & Seed Data Ready");
}

initDb().catch(console.error);

// --- HELPERS to match Frontend Expectations (_id) ---
const formatPlayer = (p) => ({ ...p, _id: p.id.toString() });
const formatTeam = (t) => ({ ...t, _id: t.id.toString() });

// --- SOCKET LOGIC ---
const io = new Server(server, { cors: { origin: "*" } });

io.on('connection', async (socket) => {
    console.log(`⚡ Connected: ${socket.id}`);

    const broadcastData = async () => {
        const players = (await db.execute("SELECT * FROM players")).rows.map(formatPlayer);
        const teams = (await db.execute("SELECT * FROM teams")).rows.map(formatTeam);
        const chats = (await db.execute("SELECT * FROM chats ORDER BY timestamp ASC LIMIT 100")).rows;
        
        const stateRes = await db.execute("SELECT * FROM auction_state WHERE id = 1");
        const stateRaw = stateRes.rows[0];
        
        let state = { ...stateRaw };
        if (stateRaw.activePlayerId) {
            const pRes = await db.execute({
                sql: "SELECT * FROM players WHERE id = ?",
                args: [stateRaw.activePlayerId]
            });
            state.activePlayerId = formatPlayer(pRes.rows[0]);
        }

        socket.emit('initialData', { players, teams, state, chats });
    };

    await broadcastData();

    // 1. Add Player
    socket.on('addPlayer', async (data) => {
        try {
            await db.execute({
                sql: "INSERT INTO players (name, strength, cardType, baseValue, status, soldTo) VALUES (?, ?, ?, ?, ?, ?)",
                args: [data.name, data.strength, data.cardType, data.baseValue, 'Available', '-']
            });
            const allPlayers = (await db.execute("SELECT * FROM players")).rows.map(formatPlayer);
            io.emit('updatePlayers', allPlayers);
        } catch (e) { socket.emit('errorMsg', e.message); }
    });

    // 2. Delete Player
    socket.on('deletePlayer', async (playerId) => {
        await db.execute({ sql: "DELETE FROM players WHERE id = ?", args: [playerId] });
        io.emit('updatePlayers', (await db.execute("SELECT * FROM players")).rows.map(formatPlayer));
    });

    // 3. Start Auction
    socket.on('startAuction', async ({ playerId, baseValue }) => {
        await db.execute({
            sql: "UPDATE auction_state SET activePlayerId = ?, currentBid = ?, highestBidder = NULL WHERE id = 1",
            args: [playerId, baseValue]
        });
        
        const stateRaw = (await db.execute("SELECT * FROM auction_state WHERE id = 1")).rows[0];
        const pRes = await db.execute({ sql: "SELECT * FROM players WHERE id = ?", args: [playerId] });
        const populatedState = { ...stateRaw, activePlayerId: formatPlayer(pRes.rows[0]) };
        
        io.emit('updateAuction', populatedState);
    });

    // 4. Place Bid
    socket.on('placeBid', async ({ teamName, increment }) => {
        const state = (await db.execute("SELECT * FROM auction_state WHERE id = 1")).rows[0];
        const teamRes = await db.execute({ sql: "SELECT * FROM teams WHERE name = ?", args: [teamName] });
        const team = teamRes.rows[0];

        if (!state.activePlayerId) return socket.emit('errorMsg', "No active auction!");
        if (state.highestBidder === teamName) return socket.emit('errorMsg', "Already leading!");

        const newBid = state.currentBid + increment;
        if (team.budget < newBid) return socket.emit('errorMsg', "Insufficient budget!");

        await db.execute({
            sql: "UPDATE auction_state SET currentBid = ?, highestBidder = ? WHERE id = 1",
            args: [newBid, teamName]
        });

        const updatedStateRaw = (await db.execute("SELECT * FROM auction_state WHERE id = 1")).rows[0];
        const pRes = await db.execute({ sql: "SELECT * FROM players WHERE id = ?", args: [updatedStateRaw.activePlayerId] });
        io.emit('updateAuction', { ...updatedStateRaw, activePlayerId: formatPlayer(pRes.rows[0]) });
    });

    // 5. Sell Player
    socket.on('sellPlayer', async () => {
        const state = (await db.execute("SELECT * FROM auction_state WHERE id = 1")).rows[0];
        if (!state.activePlayerId || !state.highestBidder) return;

        // Deduct Budget
        await db.execute({
            sql: "UPDATE teams SET budget = budget - ? WHERE name = ?",
            args: [state.currentBid, state.highestBidder]
        });

        // Mark Player Sold
        await db.execute({
            sql: "UPDATE players SET status = 'Sold', soldTo = ? WHERE id = ?",
            args: [`${state.highestBidder} (${state.currentBid}L)`, state.activePlayerId]
        });

        // Reset State
        await db.execute("UPDATE auction_state SET activePlayerId = NULL, currentBid = 0, highestBidder = NULL WHERE id = 1");

        io.emit('updateTeams', (await db.execute("SELECT * FROM teams")).rows.map(formatTeam));
        io.emit('updatePlayers', (await db.execute("SELECT * FROM players")).rows.map(formatPlayer));
        io.emit('updateAuction', { activePlayerId: null, currentBid: 0, highestBidder: null });
    });

    // 6. Cancel Auction
    socket.on('cancelAuction', async () => {
        await db.execute("UPDATE auction_state SET activePlayerId = NULL, currentBid = 0, highestBidder = NULL WHERE id = 1");
        io.emit('updateAuction', { activePlayerId: null, currentBid: 0, highestBidder: null });
    });

    // 7. Chat
    socket.on('sendMessage', async (data) => {
        const res = await db.execute({
            sql: "INSERT INTO chats (sender, role, text) VALUES (?, ?, ?) RETURNING *",
            args: [data.sender, data.role, data.text]
        });
        io.emit('newMessage', res.rows[0]);
    });
});

// --- ROUTES ---
app.use(cors({ origin: "*" }));
app.get('/health', (req, res) => res.send('Backend Turso Alive!'));

// Reset Budgets Route
app.get('/reset-teams', async (req, res) => {
    await db.execute("UPDATE teams SET budget = 1000");
    res.send("✅ Budgets Reset to 1000L");
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

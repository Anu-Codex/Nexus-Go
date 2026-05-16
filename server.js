require('dotenv').config();
const express = require('express');
const http = require('http');
const { createClient } = require('@libsql/client');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

// --- DATABASE CONNECTION ---
let dbUrl = (process.env.TURSO_DATABASE_URL || "").trim().replace("libsql://", "https://");
const dbToken = (process.env.TURSO_AUTH_TOKEN || "").trim();
const db = createClient({ url: dbUrl, authToken: dbToken });

let auctionTimer = null;
let timeLeft = 30;

const format = (row) => {
    if (!row) return null;
    return { ...row, _id: row.id ? row.id.toString() : null }; 
};

async function initDb() {
    try {
        await db.execute(`CREATE TABLE IF NOT EXISTS players (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, strength INTEGER, cardType TEXT, status TEXT, baseValue INTEGER, soldTo TEXT)`);
        await db.execute(`CREATE TABLE IF NOT EXISTS teams (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, captainEmail TEXT, budget INTEGER)`);
        await db.execute(`CREATE TABLE IF NOT EXISTS auction_state (id INTEGER PRIMARY KEY, activePlayerId INTEGER, currentBid INTEGER, highestBidder TEXT)`);
        await db.execute(`CREATE TABLE IF NOT EXISTS chats (id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT, role TEXT, text TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)`);
        await db.execute(`INSERT OR IGNORE INTO auction_state (id, activePlayerId, currentBid, highestBidder) VALUES (1, NULL, 0, NULL)`);
        
        console.log("✅ Nexus Database Ready");
        server.listen(process.env.PORT || 3000, () => console.log(`🚀 Server Live`));
    } catch (err) { console.error("DB Error:", err.message); }
}

// Timer Logic
function startTimer() {
    clearInterval(auctionTimer);
    timeLeft = 30;
    io.emit('timerUpdate', timeLeft);
    auctionTimer = setInterval(() => {
        timeLeft--;
        io.emit('timerUpdate', timeLeft);
        if (timeLeft <= 0) {
            clearInterval(auctionTimer);
            io.emit('timerDone');
        }
    }, 1000);
}

io.on('connection', async (socket) => {
    const sync = async () => {
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
    };
    await sync();

    socket.on('startAuction', async ({ playerId, baseValue }) => {
        await db.execute({ sql: "UPDATE auction_state SET activePlayerId = ?, currentBid = ?, highestBidder = NULL WHERE id = 1", args: [playerId, baseValue] });
        startTimer();
        const s = (await db.execute("SELECT * FROM auction_state WHERE id = 1")).rows[0];
        const p = (await db.execute({ sql: "SELECT * FROM players WHERE id = ?", args: [playerId] })).rows[0];
        io.emit('updateAuction', { ...s, activePlayerId: format(p) });
    });

    socket.on('placeBid', async ({ teamName, increment }) => {
        const s = (await db.execute("SELECT * FROM auction_state WHERE id = 1")).rows[0];
        const t = (await db.execute({ sql: "SELECT * FROM teams WHERE name = ?", args: [teamName] })).rows[0];
        if (t && t.budget >= (s.currentBid + increment)) {
            await db.execute({ sql: "UPDATE auction_state SET currentBid = currentBid + ?, highestBidder = ? WHERE id = 1", args: [increment, teamName] });
            startTimer(); // Reset timer on bid
            const updS = (await db.execute("SELECT * FROM auction_state WHERE id = 1")).rows[0];
            const p = (await db.execute({ sql: "SELECT * FROM players WHERE id = ?", args: [s.activePlayerId] })).rows[0];
            io.emit('updateAuction', { ...updS, activePlayerId: format(p) });
        }
    });

    socket.on('sellPlayer', async () => {
        const s = (await db.execute("SELECT * FROM auction_state WHERE id = 1")).rows[0];
        if (s.activePlayerId && s.highestBidder) {
            await db.execute({ sql: "UPDATE teams SET budget = budget - ? WHERE name = ?", args: [s.currentBid, s.highestBidder] });
            await db.execute({ sql: "UPDATE players SET status = 'Sold', soldTo = ? WHERE id = ?", args: [`${s.highestBidder} (${s.currentBid}L)`, s.activePlayerId] });
            await db.execute("UPDATE auction_state SET activePlayerId = NULL, currentBid = 0, highestBidder = NULL WHERE id = 1");
            clearInterval(auctionTimer);
            io.emit('updatePlayers', (await db.execute("SELECT * FROM players")).rows.map(format));
            io.emit('updateTeams', (await db.execute("SELECT * FROM teams")).rows.map(format));
            io.emit('updateAuction', { activePlayerId: null });
        }
    });

    socket.on('cancelAuction', async () => {
        await db.execute("UPDATE auction_state SET activePlayerId = NULL, currentBid = 0, highestBidder = NULL WHERE id = 1");
        clearInterval(auctionTimer);
        io.emit('updateAuction', { activePlayerId: null });
    });

    socket.on('deletePlayer', async (id) => {
        await db.execute({ sql: "DELETE FROM players WHERE id = ?", args: [id] });
        io.emit('updatePlayers', (await db.execute("SELECT * FROM players")).rows.map(format));
    });

    socket.on('addPlayer', async (d) => {
        await db.execute({ sql: "INSERT INTO players (name, strength, cardType, baseValue, status, soldTo) VALUES (?, ?, ?, ?, 'Available', '-')", args: [d.name, d.strength, d.cardType, d.baseValue] });
        io.emit('updatePlayers', (await db.execute("SELECT * FROM players")).rows.map(format));
    });

    socket.on('sendMessage', async (d) => {
        const res = await db.execute({ sql: "INSERT INTO chats (sender, role, text) VALUES (?, ?, ?) RETURNING *", args: [d.sender, d.role, d.text] });
        io.emit('newMessage', format(res.rows[0]));
    });
});

initDb();

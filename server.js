require('dotenv').config();
const express = require('express');
const http = require('http');
const { createClient } = require('@libsql/client');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// Helper to make SQLite data look like MongoDB data for your frontend
const format = (row) => {
    if (!row) return null;
    return { ...row, _id: row.id.toString() }; 
};

async function initDb() {
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
    console.log("✅ Turso Database Initialized");
}

initDb();

io.on('connection', async (socket) => {
    const sendData = async () => {
        const pRes = await db.execute("SELECT * FROM players");
        const tRes = await db.execute("SELECT * FROM teams");
        const cRes = await db.execute("SELECT * FROM chats ORDER BY id DESC LIMIT 50");
        const sRes = await db.execute("SELECT * FROM auction_state WHERE id = 1");

        const players = pRes.rows.map(format);
        const teams = tRes.rows.map(format);
        const chats = cRes.rows.map(format).reverse();
        let state = sRes.rows[0];

        if (state && state.activePlayerId) {
            const activeP = await db.execute({ sql: "SELECT * FROM players WHERE id = ?", args: [state.activePlayerId] });
            state.activePlayerId = format(activeP.rows[0]);
        }

        socket.emit('initialData', { players, teams, state, chats });
    };

    await sendData();

    socket.on('addPlayer', async (data) => {
        try {
            await db.execute({
                sql: "INSERT INTO players (name, strength, cardType, baseValue, status, soldTo) VALUES (?, ?, ?, ?, 'Available', '-')",
                args: [data.name, data.strength, data.cardType, data.baseValue]
            });
            const p = await db.execute("SELECT * FROM players");
            io.emit('updatePlayers', p.rows.map(format));
            socket.emit('alertMsg', "Player Added!");
        } catch (e) { console.error(e); }
    });

    socket.on('startAuction', async ({ playerId, baseValue }) => {
        await db.execute({ sql: "UPDATE auction_state SET activePlayerId = ?, currentBid = ?, highestBidder = NULL WHERE id = 1", args: [playerId, baseValue] });
        const sRes = await db.execute("SELECT * FROM auction_state WHERE id = 1");
        const pRes = await db.execute({ sql: "SELECT * FROM players WHERE id = ?", args: [playerId] });
        io.emit('updateAuction', { ...sRes.rows[0], activePlayerId: format(pRes.rows[0]) });
    });

    socket.on('placeBid', async ({ teamName, increment }) => {
        const sRes = await db.execute("SELECT * FROM auction_state WHERE id = 1");
        const state = sRes.rows[0];
        const tRes = await db.execute({ sql: "SELECT * FROM teams WHERE name = ?", args: [teamName] });
        const team = tRes.rows[0];

        const newBid = state.currentBid + increment;
        if (team.budget < newBid) return socket.emit('errorMsg', "No Budget!");

        await db.execute({ sql: "UPDATE auction_state SET currentBid = ?, highestBidder = ? WHERE id = 1", args: [newBid, teamName] });
        
        const updS = await db.execute("SELECT * FROM auction_state WHERE id = 1");
        const pRes = await db.execute({ sql: "SELECT * FROM players WHERE id = ?", args: [state.activePlayerId] });
        io.emit('updateAuction', { ...updS.rows[0], activePlayerId: format(pRes.rows[0]) });
    });

    socket.on('sellPlayer', async () => {
        const state = (await db.execute("SELECT * FROM auction_state WHERE id = 1")).rows[0];
        await db.execute({ sql: "UPDATE teams SET budget = budget - ? WHERE name = ?", args: [state.currentBid, state.highestBidder] });
        await db.execute({ sql: "UPDATE players SET status = 'Sold', soldTo = ? WHERE id = ?", args: [`${state.highestBidder} (${state.currentBid}L)`, state.activePlayerId] });
        await db.execute("UPDATE auction_state SET activePlayerId = NULL, currentBid = 0, highestBidder = NULL WHERE id = 1");
        
        const p = await db.execute("SELECT * FROM players");
        const t = await db.execute("SELECT * FROM teams");
        io.emit('updatePlayers', p.rows.map(format));
        io.emit('updateTeams', t.rows.map(format));
        io.emit('updateAuction', { activePlayerId: null });
    });

    socket.on('sendMessage', async (data) => {
        const res = await db.execute({ sql: "INSERT INTO chats (sender, role, text) VALUES (?, ?, ?) RETURNING *", args: [data.sender, data.role, data.text] });
        io.emit('newMessage', format(res.rows[0]));
    });

    socket.on('deletePlayer', async (id) => {
        await db.execute({ sql: "DELETE FROM players WHERE id = ?", args: [id] });
        const p = await db.execute("SELECT * FROM players");
        io.emit('updatePlayers', p.rows.map(format));
    });
});

app.get('/reset-teams', async (req, res) => {
    await db.execute("UPDATE teams SET budget = 1000");
    res.send("Reset Successful");
});

server.listen(process.env.PORT || 3000, () => console.log("Server Running"));

require('dotenv').config();
const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const { Server } = require('socket.io');
const cors = require('cors');

const Player = require('./models/Player');
const AuctionState = require('./models/AuctionState');
const Team = require('./models/Team');

const app = express();
const server = http.createServer(app);

const io = new Server(server, { 
    cors: { origin: "*", methods:["GET", "POST"] } 
});

app.use(cors({ origin: "*" }));
app.use(express.json());

app.get('/health', (req, res) => res.status(200).send('Backend Alive!'));

mongoose.connect(process.env.MONGODB_URI)
    .then(async () => {
        console.log('✅ MongoDB Connected');
        // List ALL 6 teams here
        const allTeams =[
                { name: "Team SHAKTI", captainEmail: "avirup@nexus.com", budget: 200 },
                { name: "Team NRG", captainEmail: "sukdeb@nexus.com", budget: 200 },
                { name: "Dominators", captainEmail: "trirup@nexus.com", budget: 200 },
                { name: "Aura Farmer's", captainEmail: "gourav@nexus.com", budget: 200 },
                { name: "RISING FALCONS", captainEmail: "abhisek@nexus.com", budget: 200 },
                { name: "Golden Knights FC", captainEmail: "sanju@nexus.com", budget: 200 }
            ];
        // This checks the database. If a team is missing, it creates them instantly!
        for (let t of allTeams) {
            const exists = await Team.findOne({ name: t.name });
            if (!exists) {
                await Team.create(t);
                console.log(`➕ Created missing team in DB: ${t.name}`);
            }
        }
    }).catch(err => console.log('❌ DB Error:', err));

app.get('/api/data', async (req, res) => {
    try {
        const players = await Player.find();
        let teams = await Team.find();
        let state = await AuctionState.findOne().populate('activePlayerId');
        if (!state) state = await AuctionState.create({});
        res.json({ players, teams, state });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

io.on('connection', (socket) => {
    console.log(`⚡ Connected: ${socket.id}`);
    // SEND INITIAL DATA ON CONNECTION
    const sendInitialData = async () => {
        try {
            const players = await Player.find();
            const teams = await Team.find();
            let state = await AuctionState.findOne().populate('activePlayerId');
            if (!state) {
                state = new AuctionState({});
                await state.save();
            }
            socket.emit('initialData', { players, teams, state });
        } catch (err) {
            console.log("Error sending initial data:", err);
        }
    };
    sendInitialData();

    // ADD PLAYER (Now optimized for speed)
    socket.on('addPlayer', async (data) => {
        try {
            // Remove the temporary ID sent by the frontend before saving
            delete data._id; 
            await new Player(data).save();
            io.emit('updatePlayers', await Player.find()); // Broadcast real DB data
        } catch (err) {
            console.log(err);
        }
    });
    // DELETE PLAYER
    socket.on('deletePlayer', async (playerId) => {
        try {
            await Player.findByIdAndDelete(playerId);
            
            // Safety Check: If the deleted player was on the live auction block, cancel the auction
            let state = await AuctionState.findOne();
            if (state && state.activePlayerId && state.activePlayerId.toString() === playerId) {
                state.activePlayerId = null;
                state.currentBid = 0;
                state.highestBidder = null;
                await state.save();
                io.emit('updateAuction', state);
            }

            // Send the updated player list to all users
            io.emit('updatePlayers', await Player.find());
        } catch (err) {
            console.log("Delete Player Error:", err);
            socket.emit('errorMsg', "Failed to delete player.");
        }
    });

    // START AUCTION (Fix applied here to prevent crashing)
    socket.on('startAuction', async ({playerId, baseValue}) => {
        try {
            let state = await AuctionState.findOne();
            // Safety check: If state got deleted or doesn't exist, create it!
            if (!state) {
                state = new AuctionState({});
            }
            state.activePlayerId = playerId;
            state.currentBid = Number(baseValue);
            state.highestBidder = null;
            await state.save();
            
            const populatedState = await AuctionState.findOne().populate('activePlayerId');
            io.emit('updateAuction', populatedState);
        } catch (err) {
            console.log("Start Auction Error:", err);
            socket.emit('errorMsg', "Failed to start auction due to Database error.");
        }
    });

    socket.on('placeBid', async ({ teamName, increment }) => {
        const team = await Team.findOne({ name: teamName });
        
        // Safety check to prevent crashing if a team name is typed wrong
        if (!team) {
            return socket.emit('errorMsg', "System Error: Team not found in database! Check exact spelling.");
        }
        let state = await AuctionState.findOne();
        if (!state.activePlayerId || state.highestBidder === teamName) return;

        const team = await Team.findOne({ name: teamName });
        const newBidAmount = state.currentBid + increment;
        
        if (team.budget < newBidAmount) {
            return socket.emit('errorMsg', "Insufficient Budget! You need " + newBidAmount + "L");
        }

        state.currentBid = newBidAmount;
        state.highestBidder = teamName;
        await state.save();
        io.emit('updateAuction', await AuctionState.findOne().populate('activePlayerId'));
    });

    socket.on('sellPlayer', async () => {
        let state = await AuctionState.findOne();
        if (!state.activePlayerId || !state.highestBidder) return;
        
        const winningTeam = await Team.findOne({ name: state.highestBidder });
        if (winningTeam) {
            winningTeam.budget -= state.currentBid;
            await winningTeam.save();
        }

        await Player.findByIdAndUpdate(state.activePlayerId, {
            status: 'Sold',
            soldTo: `${state.highestBidder} (${state.currentBid}L)`
        });

        state.activePlayerId = null; state.currentBid = 0; state.highestBidder = null;
        await state.save();

        io.emit('updateTeams', await Team.find());
        io.emit('updatePlayers', await Player.find());
        io.emit('updateAuction', state);
    });

    socket.on('cancelAuction', async () => {
        let state = await AuctionState.findOne();
        if(state) {
            state.activePlayerId = null; state.currentBid = 0; state.highestBidder = null;
            await state.save();
            io.emit('updateAuction', state);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

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

// VERY IMPORTANT FOR VERCEL: Allow any origin to connect via CORS
const io = new Server(server, { 
    cors: { origin: "*", methods:["GET", "POST"] } 
});

app.use(cors({ origin: "*" }));
app.use(express.json());

// Health Check for Render
app.get('/health', (req, res) => res.status(200).send('Backend Alive!'));

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI)
    .then(async () => {
        console.log('✅ MongoDB Connected');
        const count = await Team.countDocuments();
        if (count === 0) {
            await Team.insertMany([
                { name: "FC Strikers", captainEmail: "team1@nexus.com", budget: 200 },
                { name: "United PES", captainEmail: "team2@nexus.com", budget: 200 },
                { name: "Galacticos", captainEmail: "team3@nexus.com", budget: 200 }
            ]);
        }
    }).catch(err => console.log('❌ DB Error:', err));

// Initial Load API
app.get('/api/data', async (req, res) => {
    try {
        const players = await Player.find();
        const teams = await Team.find();
        let state = await AuctionState.findOne().populate('activePlayerId');
        if (!state) state = await AuctionState.create({});
        res.json({ players, teams, state });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

io.on('connection', (socket) => {
    console.log(`⚡ Connected: ${socket.id}`);

    socket.on('addPlayer', async (data) => {
        await new Player(data).save();
        io.emit('updatePlayers', await Player.find());
    });

    socket.on('startAuction', async ({playerId, baseValue}) => {
        let state = await AuctionState.findOne();
        state.activePlayerId = playerId;
        state.currentBid = baseValue;
        state.highestBidder = null;
        await state.save();
        io.emit('updateAuction', await AuctionState.findOne().populate('activePlayerId'));
    });

    socket.on('placeBid', async ({ teamName, increment }) => {
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
        state.activePlayerId = null; state.currentBid = 0; state.highestBidder = null;
        await state.save();
        io.emit('updateAuction', state);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

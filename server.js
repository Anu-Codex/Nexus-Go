require('dotenv').config();
const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const { Server } = require('socket.io');
const cors = require('cors');

const Player = require('./models/Player');
const AuctionState = require('./models/AuctionState');
const Team = require('./models/Team');
// CHAT SCHEMA (Saves messages to MongoDB)
const chatSchema = new mongoose.Schema({
    sender: String,
    role: String,
    text: String,
    timestamp: { type: Date, default: Date.now }
});
const Chat = mongoose.model('Chat', chatSchema);

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
                { name: "Team SHAKTI", captainEmail: "avirup@nexus.com", budget: 500 },
                { name: "Team NRG", captainEmail: "sukdeb@nexus.com", budget: 500 },
                { name: "Dominators", captainEmail: "trirup@nexus.com", budget: 500 },
                { name: "Aura Farmer's", captainEmail: "gourav@nexus.com", budget: 500 },
                { name: "RISING FALCONS", captainEmail: "abhisek@nexus.com", budget: 500 },
                { name: "Golden Knights FC", captainEmail: "sanju@nexus.com", budget: 500 }
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
// SECRET ROUTE TO FORCE-RESET ALL TEAMS
app.get('/reset-teams', async (req, res) => {
    try {
        await Team.deleteMany({}); // Delete old corrupted teams
        
        // ADD ALL 6 TEAMS HERE EXACTLY AS THEY ARE IN YOUR FRONTEND:
        await Team.insertMany([
            { name: "Team SHAKTI", captainEmail: "avirup@nexus.com", budget: 500 },
                { name: "Team NRG", captainEmail: "sukdeb@nexus.com", budget: 500 },
                { name: "Dominators", captainEmail: "trirup@nexus.com", budget: 500 },
                { name: "Aura Farmer's", captainEmail: "gourav@nexus.com", budget: 500 },
                { name: "RISING FALCONS", captainEmail: "abhisek@nexus.com", budget: 500 },
                { name: "Golden Knights FC", captainEmail: "sanju@nexus.com", budget: 500 }
        ]);
        
        res.send("✅ All 6 Teams successfully reset and budgets restored to 200 Lakhs! You can close this page and go back to your auction.");
    } catch (e) {
        res.status(500).send("Error resetting teams: " + e.message);
    }
});
// SECRET ROUTE TO FIX CRASHED BUDGETS
app.get('/fix-budgets', async (req, res) => {
    try {
        // $set forces the database to erase the bad math and perfectly set the budget to 500 Lakhs (5 Cr)
        await Team.updateMany({}, { $set: { budget: 500 } });
        
        res.send("✅ All Team budgets have been successfully rescued and reset to exactly 500 Lakhs (5 Cr)! You can close this page and refresh your auction website.");
    } catch (e) {
        res.status(500).send("Error fixing budgets: " + e.message);
    }
});

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
    // SEND INITIAL DATA ON CONNECTION
    const sendInitialData = async () => {
        try {
            const players = await Player.find();
            const teams = await Team.find();
            const chats = await Chat.find().sort({ timestamp: 1 }).limit(100); // Loads last 100 chats
            
            let state = await AuctionState.findOne().populate('activePlayerId');
            if (!state) {
                state = new AuctionState({});
                await state.save();
            }
            // Send everything including chats instantly
            socket.emit('initialData', { players, teams, state, chats });
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
    // ADD EXTRA BUDGET TO ALL TEAMS
    socket.on('addExtraBudget', async (extraAmount) => {
        try {
            // $inc is a MongoDB command that securely adds to the existing number
            await Team.updateMany({}, { $inc: { budget: Number(extraAmount) } });
            
            // Instantly update the screens for everyone
            io.emit('updateTeams', await Team.find());
            
            // Send a success popup to the Admin
            socket.emit('alertMsg', `✅ Successfully added ${extraAmount}L to all team purses!`);
        } catch (err) {
            console.log("Budget Update Error:", err);
            socket.emit('errorMsg', "Failed to update budgets.");
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

    // PLACE BID (Now with 100% strict error reporting)
    socket.on('placeBid', async ({ teamName, increment }) => {
        try {
            console.log(`👉 Bid attempt received from:[${teamName}] for +${increment}L`);
            
            let state = await AuctionState.findOne();
            
            // 1. Check if auction is actually running
            if (!state || !state.activePlayerId) {
                return socket.emit('errorMsg', "No active auction running!");
            }
            
            // 2. Check if they are already the highest bidder
            if (state.highestBidder === teamName) {
                return socket.emit('errorMsg', "You are already the highest bidder!");
            }

            // 3. Check if team exists in DB
            const team = await Team.findOne({ name: teamName });
            if (!team) {
                return socket.emit('errorMsg', `Team '${teamName}' not found in database! Please check exact spelling.`);
            }

            // 4. Check budget
            const newBidAmount = state.currentBid + increment;
            if (team.budget < newBidAmount) {
                return socket.emit('errorMsg', `Insufficient Budget! You need ${newBidAmount}L but only have ${team.budget}L.`);
            }

            // If it passes all checks, save the bid!
            state.currentBid = newBidAmount;
            state.highestBidder = teamName;
            await state.save();
            
            console.log(`✅ Bid successful! ${teamName} now holds the bid at ${newBidAmount}L`);
            
            io.emit('updateAuction', await AuctionState.findOne().populate('activePlayerId'));
            
        } catch (err) {
            console.log("❌ Server Error during bid:", err);
            socket.emit('errorMsg', "Server error while processing bid.");
        }
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

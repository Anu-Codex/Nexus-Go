const mongoose = require('mongoose');

const playerSchema = new mongoose.Schema({
    name: String,
    strength: Number,
    cardType: String,
    baseValue: Number,
    status: { type: String, default: 'Available' },
    soldTo: { type: String, default: '-' }
});

// The word 'Player' here will look for a collection named "players" in MongoDB
module.exports = mongoose.model('Player', playerSchema);

const mongoose = require('mongoose');

const playerSchema = new mongoose.Schema({
    name: { type: String, required: true },
    strength: { type: Number, required: true },
    cardType: { type: String },
    baseValue: { type: Number, required: true }, // MAKE SURE THIS MATCHES!
    status: { type: String, default: 'Available' },
    soldTo: { type: String, default: '-' }
});

module.exports = mongoose.model('Player', playerSchema);

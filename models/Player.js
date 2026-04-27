const mongoose = require('mongoose');
module.exports = mongoose.model('Player', new mongoose.Schema({
    name: { type: String, required: true },
    strength: { type: Number, required: true },
    cardType: { type: String, required: true },
    value: { type: Number, required: true },
    status: { type: String, default: 'Available' },
    soldTo: { type: String, default: '-' }
}));

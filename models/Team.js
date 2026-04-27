const mongoose = require('mongoose');
module.exports = mongoose.model('Team', new mongoose.Schema({
    name: { type: String, required: true },
    captainEmail: { type: String, required: true },
    budget: { type: Number, default: 200 } // 200 Lakhs = 2 Crores
}));

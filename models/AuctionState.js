const mongoose = require('mongoose');
module.exports = mongoose.model('AuctionState', new mongoose.Schema({
    activePlayerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Player', default: null },
    currentBid: { type: Number, default: 0 },
    highestBidder: { type: String, default: null }
}));

const mongoose = require('mongoose');

// Use a local database named 'TE_live'
const MONGO_URI = 'mongodb://127.0.0.1:27017/TE_live';

const connectDB = async () => {
    try {
        await mongoose.connect(MONGO_URI);
        console.log('✅ MongoDB Connected Successfully');
    } catch (err) {
        console.error('❌ MongoDB Connection Error:', err);
        process.exit(1);
    }
};

module.exports = connectDB;
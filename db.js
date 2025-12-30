require('dotenv').config(); // Load the .env file
const mongoose = require('mongoose');

const mongoURI = process.env.MONGO_URI;

if (!mongoURI) {
    console.error('❌ FATAL ERROR: MONGO_URI is not defined in .env file');
    process.exit(1); // Stop the app if no DB connection string
}

const connectDB = async () => {
    try {
        await mongoose.connect(mongoURI); // No options needed for Mongoose 6+
        console.log('✅ MongoDB Connected Successfully');
    } catch (err) {
        console.error('❌ MongoDB Connection Error:', err.message);
        process.exit(1);
    }
};

module.exports = connectDB;
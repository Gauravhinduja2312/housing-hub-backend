// housing-hub-backend/db.js
const mongoose = require('mongoose');
require('dotenv').config();

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB database!');
  } catch (err) {
    console.error('Failed to connect to MongoDB database:', err);
    process.exit(1); // Exit process with failure
  }
};

module.exports = connectDB;
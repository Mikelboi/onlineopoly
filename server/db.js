
const mysql = require('mysql2');
const path = require('path');
require('dotenv').config({
    path: path.join(__dirname, '.env')
});

const db = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    //host: "localhost", (hardcoded values)
    //user: "root",
    //password: "Blueman2005!",
    database: 'onlineopoly'
});

db.connect((err) => {
    if (err) {
        console.error('Database connection failed:', err.message);
        return;
    }

    console.log('Connected to the Onlineopoly database!');
});

module.exports = db;


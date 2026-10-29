

const mysql = require('mysql2');
const path = require('path');

require('dotenv').config({
    path: path.join(__dirname, '.env')
});

const db = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: 'onlineopoly',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

db.getConnection((err, connection) => {
    if (err) {
        console.error('Database connection failed:', err.message);
        return;
    }

    console.log('Connected to the Onlineopoly database!');
    connection.release();
});

module.exports = db;



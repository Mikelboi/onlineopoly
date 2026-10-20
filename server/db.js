
require('.env').config();
console.log('DB_HOST loaded:', !!process.env.DB_HOST);
console.log('DB_USER loaded:', process.env.DB_USER || '(missing)');
console.log('DB_PASSWORD loaded:', !!process.env.DB_PASSWORD);

const mysql = require('mysql2');

const db = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    //host: "localhost",
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


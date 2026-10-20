const handlePageRequest = require('./routes/pages');
const handleAccountRequest = require('./routes/account');
const handleGameRequest = require('./routes/games');
const http = require('http');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const db = require('./db');

const PORT = 3000;
const sessions = new Map();
const SESSION_DURATION = 1000 * 60 * 60 * 24; 

const server = http.createServer((req, res) => {
    console.log('Request received:', req.method, req.url);

    if (handlePageRequest(req, res)) {
        return;
    }

    if (handleAccountRequest(req, res, {db,bcrypt,crypto, sessions, SESSION_DURATION})) {
        return; 
    }

    if (handleGameRequest(req, res, {db,sessions,SESSION_DURATION})) {
        return;
    }


    // Final 404 fallback — keep this last
    res.writeHead(404, {
        'Content-Type': 'text/plain'
    });
    res.end('Not found.');
});

server.listen(PORT, () => {
    console.log(`Server is running at http://localhost:${PORT}`);
});

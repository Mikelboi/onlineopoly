const handlePageRequest = require('./routes/pages');
const handleAccountRequest = require('./routes/account');
const handleGameRequest = require('./routes/games');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const db = require('./db');

const PORT = 3000;
const sessions = new Map();
const SESSION_DURATION = 1000 * 60 * 60 * 24; 

const server = http.createServer((req, res) => {
    if (req.url.startsWith('/socket.io/')) {
        return;
    }
    console.log('Request received:', req.method, req.url);

    if (handlePageRequest(req, res)) {
        return;
    }

    if (handleAccountRequest(req, res, {db,bcrypt,crypto, sessions, SESSION_DURATION})) {
        return; 
    }

    if (handleGameRequest(req, res, {db,sessions,SESSION_DURATION,io})) {
        return;
    }


    // Final 404 fallback — keep this last
    res.writeHead(404, {
        'Content-Type': 'text/plain'
    });
    res.end('Not found.');
});

const io = new Server(server);

io.use((socket, next) => {
    const cookieHeader = socket.handshake.headers.cookie || '';

io.on('connection', (socket) => {
    console.log('Socket connected:', socket.data.username);

    socket.on('joinGame', (gameId) => {
        const roomName = `game-${gameId}`;
        socket.join(roomName);

        console.log(`${socket.data.username} joined ${roomName}`);
    });
});

    const sessionCookie = cookieHeader
        .split(';')
        .map(cookie => cookie.trim())
        .find(cookie => cookie.startsWith('onlineopoly_session='));

    if (!sessionCookie) {
        return next(new Error('Authentication required'));
    }

    const sessionId = decodeURIComponent(
        sessionCookie.substring('onlineopoly_session='.length)
    );

    const session = sessions.get(sessionId);

    if (!session || session.expiresAt <= Date.now()) {
        return next(new Error('Invalid or expired session'));
    }

    // Attach the verified login information to this socket.
    socket.data.userId = session.userId;
    socket.data.username = session.username;

    next();
});


io.on('connection', (socket) => {
    console.log('A player connected:', socket.id);

    socket.on('join-game', (gameId) => {
        console.log('Received join-game event:', gameId);

        // Validate the game ID.
        if (!Number.isSafeInteger(Number(gameId)) || Number(gameId) <= 0) {
            console.log('Invalid game ID:', gameId);
            return;
        }

        const validGameId = Number(gameId);

        // Check whether this game exists.
        db.query(
            'SELECT game_id FROM `Game` WHERE game_id = ?',
            [validGameId],
            (err, games) => {
                if (err) {
                    console.error('Check game error:', err);
                    return;
                }

                if (games.length === 0) {
                    console.log('Game does not exist:', validGameId);
                    return;
                }

                // Check whether the logged-in user belongs to this game.
                db.query(
                    'SELECT player_id FROM `Player` WHERE user_id = ? AND game_id = ?',
                    [socket.data.userId, validGameId],
                    (err, players) => {
                        if (err) {
                            console.error('Check game membership error:', err);
                            return;
                        }

                        if (players.length === 0) {
                            console.log(
                                `User ${socket.data.userId} is not a member of game ${validGameId}`
                            );
                            return;
                        }

                        socket.join(`game:${validGameId}`);

                        console.log(
                            `Socket ${socket.id} joined game ${validGameId}`
                        );
                    }
                );
            }
        );
    });

// Temporary test event for checking messages between players.
socket.on('test-message', (message) => {
    // Validate the message.
    if (
        !message ||
        !Number.isSafeInteger(Number(message.gameId)) ||
        Number(message.gameId) <= 0 ||
        typeof message.text !== 'string' ||
        message.text.trim().length === 0 ||
        message.text.length > 500
    ) {
        console.log('Rejected invalid test message:', message);

        console.log('Game ID:', message?.gameId);
console.log('Game ID valid:', Number.isSafeInteger(Number(message?.gameId)) && Number(message?.gameId) > 0);
console.log('Text is string:', typeof message?.text === 'string');
console.log('Text is not empty:', typeof message?.text === 'string' && message.text.trim().length > 0);
console.log('Text under 500 characters:', typeof message?.text === 'string' && message.text.length <= 500);
        return;
    }

    const gameId = Number(message.gameId);

    // Verify that the sender belongs to this game.
    db.query(
        'SELECT player_id FROM `Player` WHERE user_id = ? AND game_id = ?',
        [socket.data.userId, gameId],
        (err, players) => {
            if (err) {
                console.error('Verify message sender error:', err);
                return;
            }

            if (players.length === 0) {
                console.log(
                    `Rejected message: user ${socket.data.userId} is not in game ${gameId}`
                );
                return;
            }

            // Send the message only to the verified game's room.
            io.to(`game:${gameId}`).emit(
                'test-message',
                message.text.trim()
            );

            console.log(
                `User ${socket.data.userId} sent a message to game ${gameId}`
            );
        }
    );
});

    socket.on('disconnect', () => {
        console.log('A player disconnected:', socket.id);
    });
});

server.listen(PORT, () => {
    console.log(`Server is running at http://localhost:${PORT}`);
});


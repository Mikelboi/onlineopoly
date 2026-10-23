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

    socket.data.userId = session.userId;
    socket.data.username = session.username;

    next();
});

io.on('connection', (socket) => {
    console.log('Socket.IO connection established:', socket.id);
    console.log('Socket connected:', socket.data.username);

    socket.on('joinGame', (gameId) => {
        const validGameId = Number(gameId);

        if (!Number.isSafeInteger(validGameId) || validGameId <= 0) {
            return;
        }

        db.query(
            'SELECT player_id FROM `Player` WHERE user_id = ? AND game_id = ?',
            [socket.data.userId, validGameId],
            (err, players) => {
                if (err) {
                    console.error('Game membership error:', err);
                    return;
                }

                if (players.length === 0) {
                    console.log('User is not a member of this game.');
                    return;
                }

                socket.join(`game:${validGameId}`);
                console.log(`Socket ${socket.id} joined game:${validGameId}`);
            }
        );
    });

    socket.on('tokenSelected', (data) => {
        if (!data || !Number.isSafeInteger(Number(data.gameId))) {
            return;
        }

        const gameId = Number(data.gameId);

        console.log(
            `Token selected by ${socket.data.username}; broadcasting to game:${gameId}`
        );

        socket.to(`game:${gameId}`).emit('tokenUpdated', { gameId });
    });

    socket.on('test-message', (message) => {
        if (
            !message ||
            !Number.isSafeInteger(Number(message.gameId)) ||
            Number(message.gameId) <= 0 ||
            typeof message.text !== 'string' ||
            message.text.trim().length === 0 ||
            message.text.length > 500
        ) {
            console.log('Rejected invalid test message:', message);
            return;
        }

        const gameId = Number(message.gameId);

        db.query(
            'SELECT player_id FROM `Player` WHERE user_id = ? AND game_id = ?',
            [socket.data.userId, gameId],
            (err, players) => {
                if (err) {
                    console.error('Verify message sender error:', err);
                    return;
                }

                if (players.length === 0) {
                    console.log('Rejected message: sender is not in this game.');
                    return;
                }

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


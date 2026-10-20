
const http = require('http');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const db = require('./db');

const PORT = 3000;
const sessions = new Map();
const SESSION_DURATION = 1000 * 60 * 60 * 24; 

const loginPath = path.join(__dirname, '..', 'client', 'Account', 'login.html');
const registerPath = path.join(__dirname, '..', 'client', 'Account', 'register.html');
const lobbyPath = path.join(__dirname, '..', 'client', 'Game', 'lobby.html');
const roomPath = path.join(__dirname, '..', 'client', 'Game', 'room.html');
const menuPath = path.join(__dirname, '..', 'client', 'Game', 'menu.html');

const server = http.createServer((req, res) => {
    console.log('Request received:', req.method, req.url);
    const route = req.url.split('?')[0];

    if (req.method === 'GET' && (route === '/' || route === '/login')) {
        servePage(loginPath, res);
        return;
    }

    if (req.method === 'GET' && req.url.split('?')[0] === '/menu') {
        servePage(menuPath, res);
        return;
    }

    if (req.method === 'GET' && req.url === '/register') {
        servePage(registerPath, res);
        return;
    }

    if (req.method === 'GET' && req.url === '/lobby') {
    servePage(lobbyPath, res);
    return;
    }

    if (req.method === 'GET' && req.url.startsWith('/room')) {
    servePage(roomPath, res);
    return;
    }

    if (req.method === 'POST' && req.url === '/register') {
        let body = '';

        req.on('data', chunk => {
            body += chunk;

            if (body.length > 10000) {
                res.writeHead(413, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ message: 'Request too large.' }));
                req.destroy();
            }
        });

        req.on('end', async () => {
            try {
                const { username, password } = JSON.parse(body);

                if (
                    typeof username !== 'string' ||
                    typeof password !== 'string' ||
                    !username.trim() ||
                    password.length < 8 ||
                    Buffer.byteLength(password, 'utf8') > 72
                ) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        message: 'Enter a username and a password of 8–72 bytes.'
                    }));
                    return;
                }

                const hashedPassword = await bcrypt.hash(password, 12);

                db.query(
                    'INSERT INTO `User` (username, password) VALUES (?, ?)',
                    [username.trim(), hashedPassword],
                    (err) => {
                        if (err) {
                            const duplicate = err.code === 'ER_DUP_ENTRY';

                            res.writeHead(duplicate ? 409 : 500, {
                                'Content-Type': 'application/json'
                            });
                            res.end(JSON.stringify({
                                message: duplicate
                                    ? 'That username is already taken.'
                                    : 'Could not create your account.'
                            }));
                            return;
                        }

                        res.writeHead(201, {
                            'Content-Type': 'application/json'
                        });
                        res.end(JSON.stringify({
                            message: 'Account created successfully!'
                        }));
                    }
                );
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    message: 'Invalid registration request.'
                }));
            }
        });

        return;
    }
    if (req.method === 'POST' && req.url === '/login') {
        
            let body = '';
            let requestTooLarge = false;

            req.on('data', chunk => {
                if (requestTooLarge) return;

                body += chunk;

                if (Buffer.byteLength(body, 'utf8') > 10000) {
                    requestTooLarge = true;

                    res.writeHead(413, {
                        'Content-Type': 'application/json'
                    });
                    res.end(JSON.stringify({
                        message: 'Request too large.'
                    }));
                }
            });

        req.on('end', async () => {
            if (requestTooLarge) return;
            try {
                const { username, password } = JSON.parse(body);

                if (
                    typeof username !== 'string' ||
                    typeof password !== 'string' ||
                    !username.trim() ||
                    !password
                ) {
                    res.writeHead(400, {
                        'Content-Type': 'application/json'
                    });
                    res.end(JSON.stringify({
                        message: 'Enter your username and password.'
                    }));
                    return;
                }

                db.query(
                    'SELECT user_id, username, password FROM `User` WHERE username = ?',
                    [username.trim()],
                    async (err, results) => {
                        if (err) {
                            res.writeHead(500, {
                                'Content-Type': 'application/json'
                            });
                            res.end(JSON.stringify({
                                message: 'Login could not be completed.'
                            }));
                            return;
                        }

                        if (results.length === 0) {
                            res.writeHead(401, {
                                'Content-Type': 'application/json'
                            });
                            res.end(JSON.stringify({
                                message: 'Invalid username or password.'
                            }));
                            return;
                        }

                        try {
                            const user = results[0];
                            const passwordMatches = await bcrypt.compare(
                                password,
                                user.password
                            );

                            if (!passwordMatches) {
                                res.writeHead(401, {
                                    'Content-Type': 'application/json'
                                });
                                res.end(JSON.stringify({
                                    message: 'Invalid username or password.'
                                }));
                                return;
                            }
                            
                           
                            const sessionId = crypto.randomBytes(32).toString('hex');

                            sessions.set(sessionId, {
                                userId: user.user_id,
                                username: user.username,
                                expiresAt: Date.now() + SESSION_DURATION
                            });

                            if (res.writableEnded) {
                                    console.log('Login response already ended before success.');
                                    return;
                            }

                            res.writeHead(200, {
                                'Content-Type': 'application/json',
                                'Set-Cookie': `onlineopoly_session=${sessionId}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`
                            });

                            res.end(JSON.stringify({
                                message: `Welcome back, ${user.username}!`,
                                userId: user.user_id
                            }));

                        } catch (error) {
                            res.writeHead(500, {
                                'Content-Type': 'application/json'
                            });
                            res.end(JSON.stringify({
                                message: 'Login could not be completed.'
                            }));
                        }
                    }
                );
            } catch (error) {
                res.writeHead(400, {
                    'Content-Type': 'application/json'
                });
                res.end(JSON.stringify({
                    message: 'Invalid login request.'
                }));
            }
        });

        return;
    }


if (req.method === 'POST' && req.url === '/games/create') {
    const cookieHeader = req.headers.cookie || '';

    const sessionCookie = cookieHeader
        .split(';')
        .map(cookie => cookie.trim())
        .find(cookie => cookie.startsWith('onlineopoly_session='));

    if (!sessionCookie) {
        res.writeHead(401, {
            'Content-Type': 'application/json'
        });
        res.end(JSON.stringify({
            message: 'Please log in before creating a game.'
        }));
        return;
    }

    const sessionId = sessionCookie.substring(
        'onlineopoly_session='.length
    );

    const session = sessions.get(sessionId);

    if (!session || session.expiresAt <= Date.now()) {
        if (session) {
            sessions.delete(sessionId);
        }

        res.writeHead(401, {
            'Content-Type': 'application/json'
        });
        res.end(JSON.stringify({
            message: 'Your session is invalid or expired.'
        }));
        return;
    }

    db.query(
        "INSERT INTO `Game` (game_status, player_count, host_user_id) VALUES ('waiting', 0,?)",
        [session.userId],
        (err, result) => {
            if (err) {
                console.error('Create game error:', err);

                res.writeHead(500, {
                    'Content-Type': 'application/json'
                });
                res.end(JSON.stringify({
                    message: 'Could not create the game.'
                }));
                return;
            }

            res.writeHead(201, {
                'Content-Type': 'application/json'
            });
            res.end(JSON.stringify({
                message: 'Game created successfully!',
                gameId: result.insertId
            }));
        }
    );

    return;
}

if (req.method === 'POST' && req.url === '/games/join') {
    const cookieHeader = req.headers.cookie || '';

    const sessionCookie = cookieHeader
        .split(';')
        .map(cookie => cookie.trim())
        .find(cookie => cookie.startsWith('onlineopoly_session='));

    if (!sessionCookie) {
        res.writeHead(401, {
            'Content-Type': 'application/json'
        });
        res.end(JSON.stringify({
            message: 'Please log in before joining a game.'
        }));
        return;
    }

    const sessionId = sessionCookie.substring(
        'onlineopoly_session='.length
    );

    const session = sessions.get(sessionId);

    if (!session || session.expiresAt <= Date.now()) {
        if (session) sessions.delete(sessionId);

        res.writeHead(401, {
            'Content-Type': 'application/json'
        });
        res.end(JSON.stringify({
            message: 'Your session is invalid or expired.'
        }));
        return;
    }

    let body = '';
    let requestTooLarge = false;

    req.on('data', chunk => {
        if (requestTooLarge) return;

        body += chunk;

        if (Buffer.byteLength(body, 'utf8') > 10000) {
            requestTooLarge = true;

            res.writeHead(413, {
                'Content-Type': 'application/json'
            });
            res.end(JSON.stringify({
                message: 'Request too large.'
            }));
        }
    });

    req.on('end', () => {
        if (requestTooLarge) return;

        let gameId;

        try {
            const data = JSON.parse(body);
            gameId = data.gameId;

            if (
                !Number.isSafeInteger(gameId) ||
                gameId <= 0
            ) {
                res.writeHead(400, {
                    'Content-Type': 'application/json'
                });
                res.end(JSON.stringify({
                    message: 'Please provide a valid game ID.'
                }));
                return;
            }
        } catch (error) {
            res.writeHead(400, {
                'Content-Type': 'application/json'
            });
            res.end(JSON.stringify({
                message: 'Invalid request.'
            }));
            return;
        }

        db.query(
            'SELECT game_id FROM `Game` WHERE game_id = ? AND game_status = ?',
            [gameId, 'waiting'],
            (err, games) => {
                if (err) {
                    console.error('Find game error:', err);
                    res.writeHead(500, {
                        'Content-Type': 'application/json'
                    });
                    res.end(JSON.stringify({
                        message: 'Could not check the game.'
                    }));
                    return;
                }

                if (games.length === 0) {
                    res.writeHead(404, {
                        'Content-Type': 'application/json'
                    });
                    res.end(JSON.stringify({
                        message: 'Game not found or is no longer waiting.'
                    }));
                    return;
                }

                db.query(
                    'SELECT player_id FROM `Player` WHERE user_id = ? AND game_id = ?',
                    [session.userId, gameId],
                    (err, players) => {
                        if (err) {
                            console.error('Check player error:', err);
                            res.writeHead(500, {
                                'Content-Type': 'application/json'
                            });
                            res.end(JSON.stringify({
                                message: 'Could not check your game membership.'
                            }));
                            return;
                        }

                        if (players.length > 0) {
                            res.writeHead(409, {
                                'Content-Type': 'application/json'
                            });
                            res.end(JSON.stringify({
                                message: 'You have already joined this game.'
                            }));
                            return;
                        }

                        db.query(
                            'INSERT INTO `Player` (player_name, user_id, game_id) VALUES (?, ?, ?)',
                            [session.username, session.userId, gameId],
                            (err, result) => {
                                if (err) {
                                    console.error('Join game error:', err);
                                    res.writeHead(500, {
                                        'Content-Type': 'application/json'
                                    });
                                    res.end(JSON.stringify({
                                        message: 'Could not join the game.'
                                    }));
                                    return;
                                }

                                db.query(
                                    'UPDATE `Game` SET player_count = player_count + 1 WHERE game_id = ?',
                                    [gameId],
                                    (err) => {
                                        if (err) {
                                            console.error('Update player count error:', err);
                                            res.writeHead(500, {
                                                'Content-Type': 'application/json'
                                            });
                                            res.end(JSON.stringify({
                                                message: 'Player joined, but the game count could not be updated.'
                                            }));
                                            return;
                                        }

                                        res.writeHead(201, {
                                            'Content-Type': 'application/json'
                                        });
                                        res.end(JSON.stringify({
                                            message: 'You joined the game successfully!',
                                            gameId: gameId,
                                            playerId: result.insertId,
                                            username: session.username
                                        }));
                                    }
                                );
                            }
                        );
                    }
                );
            }
        );
    });

    return;
}

if (req.method === 'GET' && req.url === '/session') {
    const cookieHeader = req.headers.cookie || '';

    const sessionCookie = cookieHeader
        .split(';')
        .map(cookie => cookie.trim())
        .find(cookie => cookie.startsWith('onlineopoly_session='));

    if (!sessionCookie) {
        res.writeHead(401, {
            'Content-Type': 'application/json'
        });
        res.end(JSON.stringify({
            loggedIn: false,
            message: 'You are not logged in.'
        }));
        return;
    }

    const sessionId = sessionCookie.substring(
        'onlineopoly_session='.length
    );

    const session = sessions.get(sessionId);

    if (!session || session.expiresAt <= Date.now()) {
        if (session) {
            sessions.delete(sessionId);
        }

        res.writeHead(401, {
            'Content-Type': 'application/json'
        });
        res.end(JSON.stringify({
            loggedIn: false,
            message: 'Your session is invalid or expired.'
        }));
        return;
    }

    res.writeHead(200, {
        'Content-Type': 'application/json'
    });
    res.end(JSON.stringify({
        loggedIn: true,
        userId: session.userId,
        username: session.username
    }));
    return;
}


if (req.method === 'GET' && req.url === '/games') {
    const cookieHeader = req.headers.cookie || '';

    const sessionCookie = cookieHeader
        .split(';')
        .map(cookie => cookie.trim())
        .find(cookie => cookie.startsWith('onlineopoly_session='));

    if (!sessionCookie) {
        res.writeHead(401, {
            'Content-Type': 'application/json'
        });
        res.end(JSON.stringify({
            message: 'Please log in to view games.'
        }));
        return;
    }

    const sessionId = sessionCookie.substring(
        'onlineopoly_session='.length
    );

    const session = sessions.get(sessionId);

    if (!session || session.expiresAt <= Date.now()) {
        if (session) {
            sessions.delete(sessionId);
        }

        res.writeHead(401, {
            'Content-Type': 'application/json'
        });
        res.end(JSON.stringify({
            message: 'Your session is invalid or expired.'
        }));
        return;
    }

    db.query(
        "SELECT game_id, player_count, game_status FROM `Game` WHERE game_status = 'waiting' ORDER BY game_id DESC",
        (err, games) => {
            if (err) {
                console.error('Load games error:', err);

                res.writeHead(500, {
                    'Content-Type': 'application/json'
                });
                res.end(JSON.stringify({
                    message: 'Could not load available games.'
                }));
                return;
            }

            res.writeHead(200, {
                'Content-Type': 'application/json'
            });
            res.end(JSON.stringify({ games: games }));
        }
    );

    return;
}

    // Get game room information and its players
    if (req.method === 'GET' && req.url.startsWith('/game-room?')) {
        const cookies = req.headers.cookie || '';

        const sessionCookie = cookies
            .split('; ')
            .find(cookie => cookie.startsWith('onlineopoly_session='));

        const sessionId = sessionCookie
            ? sessionCookie.split('=').slice(1).join('=')
            : null;

        const session = sessionId ? sessions.get(sessionId) : null;

        if (!session) {
            res.writeHead(401, {
                'Content-Type': 'application/json'
            });
            res.end(JSON.stringify({
                message: 'Please log in first.'
            }));
            return;
        }

        const requestUrl = new URL(req.url, 'http://localhost:3000');
        const gameId = Number(requestUrl.searchParams.get('gameId'));

        if (!Number.isInteger(gameId) || gameId <= 0) {
            res.writeHead(400, {
                'Content-Type': 'application/json'
            });
            res.end(JSON.stringify({
                message: 'Invalid game ID.'
            }));
            return;
        }

        db.query(
            `SELECT game_id, game_status, player_count,host_user_id
             FROM \`Game\`
             WHERE game_id = ?`,
            [gameId],
            (err, games) => {
                if (err) {
                    console.error(err);

                    res.writeHead(500, {
                        'Content-Type': 'application/json'
                    });
                    res.end(JSON.stringify({
                        message: 'Database error loading game.'
                    }));
                    return;
                }

                if (games.length === 0) {
                    res.writeHead(404, {
                        'Content-Type': 'application/json'
                    });
                    res.end(JSON.stringify({
                        message: 'Game not found.'
                    }));
                    return;
                }

                db.query(
                    `SELECT player_id, player_name, money, position
                     FROM Player
                     WHERE game_id = ?
                     ORDER BY player_id`,
                    [gameId],
                    (playerErr, players) => {
                        if (playerErr) {
                            console.error(playerErr);

                            res.writeHead(500, {
                                'Content-Type': 'application/json'
                            });
                            res.end(JSON.stringify({
                                message: 'Database error loading players.'
                            }));
                            return;
                        }

                        res.writeHead(200, {
                            'Content-Type': 'application/json'
                        });

                        res.end(JSON.stringify({
                            game: games[0], 
                            players: players
                        }));
                    }
                );
            }
        );

        return;
    }

    
if (req.method === 'POST' && req.url === '/games/start') {
    const cookieHeader = req.headers.cookie || '';

    const sessionCookie = cookieHeader
        .split(';')
        .map(cookie => cookie.trim())
        .find(cookie => cookie.startsWith('onlineopoly_session='));

    if (!sessionCookie) {
        res.writeHead(401, {
            'Content-Type': 'application/json'
        });
        res.end(JSON.stringify({
            message: 'Please log in before starting a game.'
        }));
        return;
    }

    const sessionId = sessionCookie.substring(
        'onlineopoly_session='.length
    );
    const session = sessions.get(sessionId);

    if (!session || session.expiresAt <= Date.now()) {
        if (session) sessions.delete(sessionId);

        res.writeHead(401, {
            'Content-Type': 'application/json'
        });
        res.end(JSON.stringify({
            message: 'Your session is invalid or expired.'
        }));
        return;
    }

    let body = '';

    req.on('data', chunk => {
        body += chunk;

        if (Buffer.byteLength(body, 'utf8') > 10000) {
            res.writeHead(413, {
                'Content-Type': 'application/json'
            });
            res.end(JSON.stringify({
                message: 'Request too large.'
            }));
            req.destroy();
        }
    });

    req.on('end', () => {
        let gameId;

        try {
            const requestData = JSON.parse(body);
            gameId = Number(requestData.gameId);
        } catch (error) {
            res.writeHead(400, {
                'Content-Type': 'application/json'
            });
            res.end(JSON.stringify({
                message: 'Invalid request.'
            }));
            return;
        }

        if (!Number.isInteger(gameId) || gameId <= 0) {
            res.writeHead(400, {
                'Content-Type': 'application/json'
            });
            res.end(JSON.stringify({
                message: 'Invalid game ID.'
            }));
            return;
        }

        db.query(
            `SELECT game_status, host_user_id FROM Game WHERE game_id = ?`,
            [gameId],
            (err, games) => {
                if (err) {
                    console.error('Find game error:', err);
                    res.writeHead(500, {
                        'Content-Type': 'application/json'
                    });
                    res.end(JSON.stringify({
                        message: 'Could not check the game.'
                    }));
                    return;
                }

                if (games.length === 0) {
                    res.writeHead(404, {
                        'Content-Type': 'application/json'
                    });
                    res.end(JSON.stringify({
                        message: 'Game not found.'
                    }));
                    return;
                }

                if (Number(games[0].host_user_id) !== Number(session.userId)) {
                    res.writeHead(403, {
                        'Content-Type': 'application/json'
                    });
                    res.end(JSON.stringify({
                        message: 'Only the host can start this game.'
                    }));
                    return;
                }

                if (games[0].game_status !== 'waiting') {
                    res.writeHead(409, {
                        'Content-Type': 'application/json'
                    });
                    res.end(JSON.stringify({
                        message: 'This game has already started.'
                    }));
                    return;
                }

                db.query(
                    `SELECT player_id FROM Player
                     WHERE game_id = ? AND user_id = ?`,
                    [gameId, session.userId],
                    (playerErr, playerRows) => {
                        if (playerErr) {
                            console.error('Check player error:', playerErr);
                            res.writeHead(500, {
                                'Content-Type': 'application/json'
                            });
                            res.end(JSON.stringify({
                                message: 'Could not verify your participation.'
                            }));
                            return;
                        }

                        if (playerRows.length === 0) {
                            res.writeHead(403, {
                                'Content-Type': 'application/json'
                            });
                            res.end(JSON.stringify({
                                message: 'You must join this game first.'
                            }));
                            return;
                        }

                        db.query(
                            `SELECT COUNT(*) AS playerCount
                             FROM Player WHERE game_id = ?`,
                            [gameId],
                            (countErr, results) => {
                                if (countErr) {
                                    console.error('Count players error:', countErr);
                                    res.writeHead(500, {
                                        'Content-Type': 'application/json'
                                    });
                                    res.end(JSON.stringify({
                                        message: 'Could not check the players.'
                                    }));
                                    return;
                                }

                                if (results[0].playerCount < 2) {
                                    res.writeHead(400, {
                                        'Content-Type': 'application/json'
                                    });
                                    res.end(JSON.stringify({
                                        message: 'At least 2 players are needed to start.'
                                    }));
                                    return;
                                }

                                db.query(
                                    `UPDATE Game
                                     SET game_status = 'in_progress',
                                         gamestarted_at = CURRENT_TIMESTAMP
                                     WHERE game_id = ?
                                       AND game_status = 'waiting'`,
                                    [gameId],
                                    (updateErr, result) => {
                                        if (updateErr) {
                                            console.error('Start game error:', updateErr);
                                            res.writeHead(500, {
                                                'Content-Type': 'application/json'
                                            });
                                            res.end(JSON.stringify({
                                                message: 'Could not start the game.'
                                            }));
                                            return;
                                        }

                                        if (result.affectedRows === 0) {
                                            res.writeHead(409, {
                                                'Content-Type': 'application/json'
                                            });
                                            res.end(JSON.stringify({
                                                message: 'The game has already started.'
                                            }));
                                            return;
                                        }

                                        res.writeHead(200, {
                                            'Content-Type': 'application/json'
                                        });
                                        res.end(JSON.stringify({
                                            message: 'Game started successfully!',
                                            gameId: gameId
                                        }));
                                    }
                                );
                            }
                        );
                    }
                );
            }
        );
    });

    return;
}


    // Final 404 fallback — keep this last
    res.writeHead(404, {
        'Content-Type': 'text/plain'
    });
    res.end('Not found.');
});

// Helper function for displaying HTML pages
function servePage(filePath, res) {
    fs.readFile(filePath, (err, data) => {
        if (err) {
            console.error('Error loading page:', err);
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Error loading page.');
            return;
        }

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(data);
    });
}

server.listen(PORT, () => {
    console.log(`Server is running at http://localhost:${PORT}`);
});

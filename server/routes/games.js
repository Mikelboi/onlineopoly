
const {
    rollDice,
    calculateNewPosition
} = require('../gameplay/movement');

const {
    updatePlayerMoney
} = require('../gameplay/money');

function handleGameRequest(req, res, {
    db,
    sessions,
    SESSION_DURATION,
    io
}) {
    const route = req.url.split('?')[0];

    function getSession(req) {
        const cookieHeader = req.headers.cookie || '';

        const sessionCookie = cookieHeader
            .split(';')
            .map(cookie => cookie.trim())
            .find(cookie => cookie.startsWith('onlineopoly_session='));

        if (!sessionCookie) {
            return null;
        }

        const sessionId = decodeURIComponent(
            sessionCookie.substring('onlineopoly_session='.length)
        );

        const session = sessions.get(sessionId);

        if (!session || session.expiresAt <= Date.now()) {
            if (session) {
                sessions.delete(sessionId);
            }
            return null;
        }

        return session;
    }

    function sendJson(res, statusCode, data) {
        res.writeHead(statusCode, {
            'Content-Type': 'application/json'
        });
        res.end(JSON.stringify(data));
    }

    function readJsonBody(req, res, callback) {
        let body = '';
        let tooLarge = false;

        req.on('data', chunk => {
            if (tooLarge) return;

            body += chunk;

            if (Buffer.byteLength(body, 'utf8') > 10000) {
                tooLarge = true;
                sendJson(res, 413, {
                    message: 'Request too large.'
                });
            }
        });

        req.on('end', () => {
            if (tooLarge) return;

            try {
                callback(JSON.parse(body));
            } catch (error) {
                sendJson(res, 400, {
                    message: 'Invalid request.'
                });
            }
        });
    }

    // CREATE GAME
    if (req.method === 'POST' && route === '/games/create') {
        const session = getSession(req);

        if (!session) {
            sendJson(res, 401, {
                message: 'Please log in before creating a game.'
            });
            return true;
        }

        db.query(
            `INSERT INTO Game
                (game_status, player_count, host_user_id)
             VALUES ('waiting', 1, ?)`,
            [session.userId],
            (err, result) => {
                if (err) {
                    console.error('Create game error:', err);
                    sendJson(res, 500, {
                        message: 'Could not create the game.'
                    });
                    return;
                }

                const gameId = result.insertId;

                db.query(
                    `INSERT INTO Player
                        (player_name, user_id, game_id, token_type)
                     VALUES (?, ?, ?, ?)`,
                    [
                        session.username,
                        session.userId,
                        gameId,
                        'top_hat'
                    ],
                    playerErr => {
                        if (playerErr) {
                            console.error(
                                'Add host to game error:',
                                playerErr
                            );

                            db.query(
                                'DELETE FROM Game WHERE game_id = ?',
                                [gameId],
                                deleteErr => {
                                    if (deleteErr) {
                                        console.error(
                                            'Game cleanup error:',
                                            deleteErr
                                        );
                                    }

                                    sendJson(res, 500, {
                                        message:
                                            'Game was created, but the host could not be added.'
                                    });
                                }
                            );
                            return;
                        }

                        sendJson(res, 201, {
                            message: 'Game created successfully!',
                            gameId
                        });
                    }
                );
            }
        );

        return true;
    }

    // JOIN GAME
    if (req.method === 'POST' && route === '/games/join') {
        const session = getSession(req);

        if (!session) {
            sendJson(res, 401, {
                message: 'Please log in before joining a game.'
            });
            return true;
        }

        readJsonBody(req, res, requestData => {
            const gameId = Number(requestData.gameId);

            if (!Number.isSafeInteger(gameId) || gameId <= 0) {
                sendJson(res, 400, {
                    message: 'Invalid game ID.'
                });
                return;
            }

            db.query(
                `SELECT game_id
                 FROM Game
                 WHERE game_id = ? AND game_status = 'waiting'`,
                [gameId],
                (err, games) => {
                    if (err) {
                        console.error('Find game error:', err);
                        sendJson(res, 500, {
                            message: 'Could not find the game.'
                        });
                        return;
                    }

                    if (games.length === 0) {
                        sendJson(res, 404, {
                            message: 'Waiting game not found.'
                        });
                        return;
                    }

                    db.query(
                        `SELECT player_id
                         FROM Player
                         WHERE user_id = ? AND game_id = ?`,
                        [session.userId, gameId],
                        (playerErr, players) => {
                            if (playerErr) {
                                console.error(
                                    'Check player error:',
                                    playerErr
                                );
                                sendJson(res, 500, {
                                    message:
                                        'Could not check game membership.'
                                });
                                return;
                            }

                            if (players.length > 0) {
                                sendJson(res, 200, {
                                    message: 'You are already in this game.',
                                    gameId
                                });
                                return;
                            }

                            db.query(
                                `SELECT player_count
                                 FROM Game
                                 WHERE game_id = ?`,
                                [gameId],
                                (countErr, countRows) => {
                                    if (countErr) {
                                        console.error(
                                            'Check player count error:',
                                            countErr
                                        );
                                        sendJson(res, 500, {
                                            message:
                                                'Could not check the player count.'
                                        });
                                        return;
                                    }

                                    if (
                                        countRows.length === 0 ||
                                        countRows[0].player_count >= 8
                                    ) {
                                        sendJson(res, 400, {
                                            message:
                                                'This game is full or unavailable.'
                                        });
                                        return;
                                    }

                                    db.query(
                                        `INSERT INTO Player
                                            (player_name, user_id, game_id, token_type)
                                         VALUES (?, ?, ?, ?)`,
                                        [
                                            session.username,
                                            session.userId,
                                            gameId,
                                            'top_hat'
                                        ],
                                        insertErr => {
                                            if (insertErr) {
                                                console.error(
                                                    'Join game error:',
                                                    insertErr
                                                );
                                                sendJson(res, 500, {
                                                    message:
                                                        'Could not join the game.'
                                                });
                                                return;
                                            }

                                            db.query(
                                                `UPDATE Game
                                                 SET player_count = player_count + 1
                                                 WHERE game_id = ?`,
                                                [gameId],
                                                updateErr => {
                                                    if (updateErr) {
                                                        console.error(
                                                            'Update player count error:',
                                                            updateErr
                                                        );
                                                        sendJson(res, 500, {
                                                            message:
                                                                'Joined the game, but could not update its player count.'
                                                        });
                                                        return;
                                                    }

                                                    sendJson(res, 200, {
                                                        message:
                                                            'Joined game successfully!',
                                                        gameId
                                                    });
                                                }
                                            );
                                        }
                                    );
                                }
                            );
                        }
                    );
                }
            );
        });

        return true;
    }

    // LIST WAITING GAMES
    if (req.method === 'GET' && route === '/games') {
        const session = getSession(req);

        if (!session) {
            sendJson(res, 401, {
                message: 'Please log in to view games.'
            });
            return true;
        }

        db.query(
            `SELECT game_id, player_count, game_status
             FROM Game
             WHERE game_status = 'waiting'
             ORDER BY game_id DESC`,
            (err, games) => {
                if (err) {
                    console.error('Load games error:', err);
                    sendJson(res, 500, {
                        message: 'Could not load available games.'
                    });
                    return;
                }

                sendJson(res, 200, { games });
            }
        );

        return true;
    }

    // LOAD GAME ROOM DATA
    if (req.method === 'GET' && route === '/game-room') {
        const session = getSession(req);

        if (!session) {
            sendJson(res, 401, {
                message: 'Please log in first.'
            });
            return true;
        }

        const requestUrl = new URL(req.url, 'http://localhost:3000');
        const gameId = Number(requestUrl.searchParams.get('gameId'));

        if (!Number.isSafeInteger(gameId) || gameId <= 0) {
            sendJson(res, 400, {
                message: 'Invalid game ID.'
            });
            return true;
        }

        db.query(
            `SELECT game_id, game_status, player_count, host_user_id
             FROM Game
             WHERE game_id = ?`,
            [gameId],
            (err, games) => {
                if (err) {
                    console.error('Load game error:', err);
                    sendJson(res, 500, {
                        message: 'Database error loading game.'
                    });
                    return;
                }

                if (games.length === 0) {
                    sendJson(res, 404, {
                        message: 'Game not found.'
                    });
                    return;
                }

                db.query(
                    `SELECT player_id, player_name, money, position, token_type
                     FROM Player
                     WHERE game_id = ?
                     ORDER BY player_id`,
                    [gameId],
                    (playerErr, players) => {
                        if (playerErr) {
                            console.error(
                                'Load players error:',
                                playerErr
                            );
                            sendJson(res, 500, {
                                message: 'Database error loading players.'
                            });
                            return;
                        }

                        const isPlayer = players.some(
                            player =>
                                Number(player.player_id) ===
                                Number(session.playerId)
                        );

                        // Verify membership by account ID as well.
                        db.query(
                            `SELECT player_id
                             FROM Player
                             WHERE game_id = ? AND user_id = ?`,
                            [gameId, session.userId],
                            (membershipErr, membership) => {
                                if (membershipErr) {
                                    console.error(
                                        'Check game membership error:',
                                        membershipErr
                                    );
                                    sendJson(res, 500, {
                                        message:
                                            'Could not verify game membership.'
                                    });
                                    return;
                                }

                                if (membership.length === 0) {
                                    sendJson(res, 403, {
                                        message:
                                            'You are not a player in this game.'
                                    });
                                    return;
                                }

                                sendJson(res, 200, {
                                    game: games[0],
                                    players
                                });
                            }
                        );
                    }
                );
            }
        );

        return true;
    }

    // SELECT PLAYER TOKEN
    if (req.method === 'POST' && route === '/games/token') {
        const session = getSession(req);

        if (!session) {
            sendJson(res, 401, {
                message: 'Please log in to select a token.'
            });
            return true;
        }

        readJsonBody(req, res, requestData => {
            const gameId = Number(requestData.gameId);
            const tokenType = requestData.tokenType;

            const allowedTokens = [
                'top_hat',
                'race_car',
                'dog',
                'battleship',
                'thimble',
                'boot',
                'cat',
                'wheelbarrow',
                'duck',
                'windmill'
            ];

            if (
                !Number.isSafeInteger(gameId) ||
                gameId <= 0 ||
                !allowedTokens.includes(tokenType)
            ) {
                sendJson(res, 400, {
                    message: 'Invalid game ID or token choice.'
                });
                return;
            }

            db.query(
                `SELECT player_id
                 FROM Player
                 WHERE game_id = ? AND user_id = ?`,
                [gameId, session.userId],
                (err, players) => {
                    if (err) {
                        console.error('Find player error:', err);
                        sendJson(res, 500, {
                            message: 'Could not find your player.'
                        });
                        return;
                    }

                    if (players.length === 0) {
                        sendJson(res, 403, {
                            message: 'You are not in this game.'
                        });
                        return;
                    }

                 db.query(
                    `UPDATE Player
                    SET token_type = ?, token_locked = 1
                    WHERE player_id = ?
                    AND game_id = ?
                    AND token_locked = 0`,
                    [tokenType, players[0].player_id, gameId],
                    (updateErr, result) => {
                        if (updateErr) {

                             if (updateErr.code === 'ER_DUP_ENTRY') {
                                sendJson(res, 409, {
                                    message: 'That token has already been chosen in this game.'
                                });
                                return;
                            }
                            console.error('Save token error:', updateErr);
                            sendJson(res, 500, {
                                message: 'Could not save your token.'
                            });
                            return;
                        }

                        if (result.affectedRows === 0) {
                            sendJson(res, 409, {
                                message: 'You have already chosen your token.'
                            });
                            return;
                        }

                        sendJson(res, 200, {
                            message: 'Token saved successfully!',
                            tokenType
                        });
                    }
                );   
            }
        );
    });
    return true;
    }

    // ROLL DICE AND MOVE PLAYER
    if (req.method === 'POST' && route === '/games/roll') {
        const session = getSession(req);

        if (!session) {
            sendJson(res, 401, {
                message: 'Please log in before rolling.'
            });
            return true;
        }

        readJsonBody(req, res, requestData => {
            const gameId = Number(requestData.gameId);

            if (!Number.isSafeInteger(gameId) || gameId <= 0) {
                sendJson(res, 400, {
                    message: 'Invalid game ID.'
                });
                return;
            }

            db.query(
                `SELECT game_status
                 FROM Game
                 WHERE game_id = ?`,
                [gameId],
                (gameErr, games) => {
                    if (gameErr) {
                        console.error('Check game status error:', gameErr);
                        sendJson(res, 500, {
                            message: 'Could not check the game status.'
                        });
                        return;
                    }

                    if (
                        games.length === 0 ||
                        games[0].game_status !== 'in_progress'
                    ) {
                        sendJson(res, 409, {
                            message: 'This game has not started or is unavailable.'
                        });
                        return;
                    }

                    db.query(
                        `SELECT player_id, position
                         FROM Player
                         WHERE game_id = ? AND user_id = ?`,
                        [gameId, session.userId],
                        (playerErr, players) => {
                            if (playerErr) {
                                console.error(
                                    'Find rolling player error:',
                                    playerErr
                                );
                                sendJson(res, 500, {
                                    message: 'Could not find your player.'
                                });
                                return;
                            }

                            if (players.length === 0) {
                                sendJson(res, 403, {
                                    message: 'You are not in this game.'
                                });
                                return;
                            }

                            const player = players[0];

                            let dice;
                            let newPosition;

                            try {
                                dice = rollDice();
                                newPosition = calculateNewPosition(
                                    Number(player.position),
                                    dice.total
                                );
                            } catch (error) {
                                console.error('Dice roll error:', error);
                                sendJson(res, 500, {
                                    message: 'Could not roll the dice.'
                                });
                                return;
                            }

                            db.query(
                                `UPDATE Player
                                 SET position = ?
                                 WHERE player_id = ? AND game_id = ?`,
                                [
                                    newPosition,
                                    player.player_id,
                                    gameId
                                ],
                                updateErr => {
                                    if (updateErr) {
                                        console.error(
                                            'Update player position error:',
                                            updateErr
                                        );
                                        sendJson(res, 500, {
                                            message:
                                                'Could not update your position.'
                                        });
                                        return;
                                    }

                                    const oldPosition = Number(player.position);
                                const passedGo = newPosition < oldPosition;
                                console.log('GO reward check:', {
                                    oldPosition,
                                    newPosition,
                                    passedGo,
                                    playerId: player.player_id
                                });

                                const finishRoll = () => {
                                    if (io) {
                                        io.to(`game:${gameId}`).emit('playerMoved', {
                                            gameId,
                                            playerId: player.player_id,
                                            oldPosition,
                                            newPosition,
                                            dice
                                        });
                                    }

                                    sendJson(res, 200, {
                                        message: passedGo
                                            ? 'Dice rolled successfully! You passed GO and collected $200.'
                                            : 'Dice rolled successfully!',
                                        dice,
                                        oldPosition,
                                        newPosition,
                                        passedGo
                                    });
                                };

                                if (passedGo) {
                                    updatePlayerMoney(db, Number(player.player_id), 200, moneyErr => {
                                        if (moneyErr) {
                                            console.error('GO reward error:', moneyErr);
                                            sendJson(res, 500, {
                                                message: 'Movement succeeded, but the GO reward failed.'
                                            });
                                            return;
                                        }

                                        finishRoll();
                                    });
                                } else {
                                    finishRoll();
                                }
                                }
                            );
                        }
                    );
                }
            );
        });

        return true;
    }

    // START GAME (HOST ONLY)
    if (req.method === 'POST' && route === '/games/start') {
        const session = getSession(req);

        if (!session) {
            sendJson(res, 401, {
                message: 'Please log in before starting a game.'
            });
            return true;
        }

        readJsonBody(req, res, requestData => {
            const gameId = Number(requestData.gameId);

            if (!Number.isSafeInteger(gameId) || gameId <= 0) {
                sendJson(res, 400, {
                    message: 'Invalid game ID.'
                });
                return;
            }

            db.query(
                `SELECT game_status, host_user_id
                 FROM Game
                 WHERE game_id = ?`,
                [gameId],
                (err, games) => {
                    if (err) {
                        console.error('Find game error:', err);
                        sendJson(res, 500, {
                            message: 'Could not check the game.'
                        });
                        return;
                    }

                    if (games.length === 0) {
                        sendJson(res, 404, {
                            message: 'Game not found.'
                        });
                        return;
                    }

                    if (
                        Number(games[0].host_user_id) !==
                        Number(session.userId)
                    ) {
                        sendJson(res, 403, {
                            message: 'Only the host can start this game.'
                        });
                        return;
                    }

                    if (games[0].game_status !== 'waiting') {
                        sendJson(res, 409, {
                            message: 'This game has already started.'
                        });
                        return;
                    }

                    db.query(
                        `SELECT COUNT(*) AS playerCount
                         FROM Player
                         WHERE game_id = ?`,
                        [gameId],
                        (countErr, results) => {
                            if (countErr) {
                                console.error(
                                    'Count players error:',
                                    countErr
                                );
                                sendJson(res, 500, {
                                    message: 'Could not check the players.'
                                });
                                return;
                            }

                            if (Number(results[0].playerCount) < 2) {
                                sendJson(res, 400, {
                                    message:
                                        'At least 2 players are needed to start.'
                                });
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
                                        console.error(
                                            'Start game error:',
                                            updateErr
                                        );
                                        sendJson(res, 500, {
                                            message: 'Could not start the game.'
                                        });
                                        return;
                                    }

                                    if (result.affectedRows === 0) {
                                        sendJson(res, 409, {
                                            message:
                                                'The game has already started.'
                                        });
                                        return;
                                    }

                                    if (io) {
                                        io.to(`game:${gameId}`).emit('gameStarted', {
                                            gameId
                                        });
                                    }

                                    sendJson(res, 200, {
                                        message: 'Game started successfully!',
                                        gameId
                                    });
                                }
                            );
                        }
                    );
                }
            );
        });

        return true;
    }

    return false;
}

module.exports = handleGameRequest;
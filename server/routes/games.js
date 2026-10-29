
const {
    rollDice,
    calculateNewPosition
} = require('../Gameplay/movement');

const {
    updatePlayerMoney
} = require('../Gameplay/money');

const {
    purchaseProperty,
    payRent
} = require('../Gameplay/properties');


function getNextPlayer(db, gameId, currentPlayerId, callback) {
    db.query(
        `SELECT player_id
         FROM Player
         WHERE game_id = ?
           AND is_bankrupt = 0
         ORDER BY player_id ASC`,
        [gameId],
        (err, players) => {
            if (err) {
                callback(err);
                return;
            }

            if (players.length === 0) {
                callback(new Error('No active players found.'));
                return;
            }

            const currentIndex = players.findIndex(
                p => Number(p.player_id) === Number(currentPlayerId)
            );

            if (currentIndex === -1) {
                callback(new Error('Current player was not found.'));
                return;
            }

            const nextIndex = (currentIndex + 1) % players.length;
            callback(null, players[nextIndex].player_id);
        }
    );
}

function advanceAuctionTurn(connection, gameId, startingPlayerId, callback) {
    connection.query(
        `SELECT current_player_id
         FROM Game
         WHERE game_id = ?
           AND game_status = 'in_progress'
         FOR UPDATE`,
        [gameId],
        (gameErr, games) => {
            if (gameErr) {
                callback(gameErr);
                return;
            }

            if (games.length === 0) {
                callback(new Error('Game is not in progress.'));
                return;
            }

            const currentPlayerId = Number(games[0].current_player_id);

            // Only advance if the auction starter still owns the turn.
            if (currentPlayerId !== Number(startingPlayerId)) {
                callback(null, false);
                return;
            }

            getNextPlayer(
                connection,
                gameId,
                startingPlayerId,
                (nextErr, nextPlayerId) => {
                    if (nextErr) {
                        callback(nextErr);
                        return;
                    }

                    connection.query(
                        `UPDATE Game
                         SET current_player_id = ?
                         WHERE game_id = ?
                           AND current_player_id = ?`,
                        [nextPlayerId, gameId, startingPlayerId],
                        (updateErr, result) => {
                            if (updateErr) {
                                callback(updateErr);
                                return;
                            }

                            if (result.affectedRows !== 1) {
                                callback(
                                    new Error('Could not advance the auction turn.')
                                );
                                return;
                            }

                            callback(null, true);
                        }
                    );
                }
            );
        }
    );
}

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

        let requestData;

        try {
            requestData = JSON.parse(body);
        } catch (error) {
            sendJson(res, 400, {
                message: 'Invalid request body.'
            });
            return;
        }

        callback(requestData);
    });

    req.on('error', error => {
        console.error('Request body error:', error);

        if (!res.headersSent) {
            sendJson(res, 400, {
                message: 'Could not read request body.'
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
                    `SELECT player_id, user_id, player_name, money, position, token_type
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

                                
                            
                                db.query(
                                    `SELECT
                                        Property.property_id,
                                        Property.property_name,
                                        CurrentOwnership.player_id
                                    FROM Property
                                    LEFT JOIN (
                                        SELECT
                                            Player_Property.property_id,
                                            Player_Property.player_id
                                        FROM Player_Property
                                        JOIN Player
                                            ON Player.player_id = Player_Property.player_id
                                        WHERE Player.game_id = ?
                                    ) AS CurrentOwnership
                                        ON CurrentOwnership.property_id = Property.property_id`,
                                    [gameId],
                                    (propertyErr, properties) => {
                                        if (propertyErr) {
                                            console.error('Load property ownership error:', propertyErr);
                                            sendJson(res, 500, {
                                                message: 'Could not load property ownership.'
                                            });
                                            return;
                                        }

                                        sendJson(res, 200, {
                                            game: games[0],
                                            players,
                                            properties,
                                            currentUserId: session.userId
                                        });
                                    }
                                );


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
                `SELECT game_status, current_player_id
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

                    if (
                        Number(games[0].current_player_id) !==
                        Number(session.userId)
                    ) {
                        // We'll correct this comparison in the next step.
                    }

                    db.query(
                        `SELECT player_id, player_name, position
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

                            if (
                                Number(games[0].current_player_id) !==
                                Number(player.player_id)
                            ) {
                                sendJson(res, 409, {
                                    message: 'It is not your turn.'
                                });
                                return;
                            }

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
                                payRent(db, Number(session.userId), Number(gameId), (rentErr, rentResult) => {
                                    if (rentErr) {
                                        console.error('Rent payment error:', rentErr);

                                        if (io) {
                                            io.to(`game:${gameId}`).emit('playerMoved', {
                                                gameId,
                                                playerId: player.player_id,
                                                playerName: player.player_name,
                                                oldPosition,
                                                newPosition,
                                                dice,
                                                diceTotal: dice.total
                                            });
                                        }

                                        sendJson(res, 500, {
                                            message: 'Movement succeeded, but rent processing failed.',
                                            dice,
                                            oldPosition,
                                            newPosition,
                                            passedGo
                                        });
                                        return;
                                    }

                                    if (io) {
                                        io.to(`game:${gameId}`).emit('playerMoved', {
                                            gameId,
                                            playerId: player.player_id,
                                            playerName: player.player_name,
                                            oldPosition,
                                            newPosition,
                                            dice,
                                            diceTotal: dice.total
                                        });
                                    }

                                    if (io && rentResult && rentResult.rentPaid) {
                                        io.to(`game:${gameId}`).emit('rentPaid', {
                                            gameId,
                                            playerId: player.player_id,
                                            playerName: player.player_name,
                                            propertyName: rentResult.propertyName,
                                            rent: rentResult.rent,
                                            ownerPlayerName: rentResult.ownerPlayerName
                                        });
                                    }

                                    sendJson(res, 200, {
                                        message: rentResult && rentResult.rentPaid
                                            ? `Dice rolled! You paid $${rentResult.rent} rent for ${rentResult.propertyName}.`
                                            : passedGo
                                                ? 'Dice rolled successfully! You passed GO and collected $200.'
                                                : 'Dice rolled successfully!',
                                        dice,
                                        oldPosition,
                                        newPosition,
                                        passedGo,
                                        rent: rentResult
                                    });
                                });
                            };


                                if (passedGo) {
                                    updatePlayerMoney(db, Number(player.player_id), Number(gameId), 200, 'GO Reward', moneyErr => {
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

    // START PROPERTY AUCTION
    if (req.method === 'POST' && route === '/games/auction/start') {
        const session = getSession(req);

        if (!session) {
            sendJson(res, 401, {
                message: 'Please log in to start an auction.'
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
                `SELECT game_status, current_player_id
                 FROM Game
                 WHERE game_id = ?`,
                [gameId],
                (gameErr, games) => {
                    if (gameErr) {
                        console.error('Auction game lookup error:', gameErr);
                        sendJson(res, 500, {
                            message: 'Could not check the game.'
                        });
                        return;
                    }

                    if (
                        games.length === 0 ||
                        games[0].game_status !== 'in_progress'
                    ) {
                        sendJson(res, 409, {
                            message: 'This game is not in progress.'
                        });
                        return;
                    }

                    db.query(
                        `SELECT player_id, player_name, position
                         FROM Player
                         WHERE game_id = ?
                           AND user_id = ?
                           AND is_bankrupt = 0`,
                        [gameId, session.userId],
                        (playerErr, players) => {
                            if (playerErr) {
                                console.error('Auction player lookup error:', playerErr);
                                sendJson(res, 500, {
                                    message: 'Could not find your player.'
                                });
                                return;
                            }

                            if (players.length === 0) {
                                sendJson(res, 403, {
                                    message: 'You are not an active player in this game.'
                                });
                                return;
                            }

                            const player = players[0];

                            if (
                                Number(games[0].current_player_id) !==
                                Number(player.player_id)
                            ) {
                                sendJson(res, 409, {
                                    message: 'It is not your turn.'
                                });
                                return;
                            }

                            // Find the property at the player's current position.
                            db.query(
                                `SELECT property_id, property_name
                                 FROM Property
                                 WHERE board_position = ?`,
                                [player.position],
                                (propertyErr, properties) => {
                                    if (propertyErr) {
                                        console.error('Auction property lookup error:', propertyErr);
                                        sendJson(res, 500, {
                                            message: 'Could not find the property.'
                                        });
                                        return;
                                    }

                                    if (properties.length === 0) {
                                        sendJson(res, 409, {
                                            message: 'There is no property to auction at this position.'
                                        });
                                        return;
                                    }

                                    const property = properties[0];

                                    db.query(
                                        `SELECT Player_Property.player_id
                                         FROM Player_Property
                                         JOIN Player
                                           ON Player.player_id = Player_Property.player_id
                                         WHERE Player_Property.property_id = ?
                                           AND Player.game_id = ?`,
                                        [property.property_id, gameId],
                                        (ownerErr, owners) => {
                                            if (ownerErr) {
                                                console.error('Auction ownership lookup error:', ownerErr);
                                                sendJson(res, 500, {
                                                    message: 'Could not check property ownership.'
                                                });
                                                return;
                                            }

                                            if (owners.length > 0) {
                                                sendJson(res, 409, {
                                                    message: 'This property is already owned.'
                                                });
                                                return;
                                            }

                                            db.query(
                                                `SELECT auction_id
                                                 FROM Property_Auction
                                                 WHERE game_id = ?
                                                   AND auction_status = 'open'`,
                                                [gameId],
                                                (auctionErr, openAuctions) => {
                                                    if (auctionErr) {
                                                        console.error('Open auction lookup error:', auctionErr);
                                                        sendJson(res, 500, {
                                                            message: 'Could not check active auctions.'
                                                        });
                                                        return;
                                                    }

                                                    if (openAuctions.length > 0) {
                                                        sendJson(res, 409, {
                                                            message: 'An auction is already open in this game.'
                                                        });
                                                        return;
                                                    }

                                                    db.query(
                                                        `INSERT INTO Property_Auction
                                                            (game_id, property_id, starting_player_id,
                                                            highest_bid, highest_bidder_id,
                                                            auction_status, ends_at)
                                                        VALUES (?, ?, ?, 0, NULL, 'open',
                                                                DATE_ADD(NOW(), INTERVAL 30 SECOND))`,
                                                        [gameId, property.property_id, player.player_id],
                                                        (insertErr, result) => {
                                                            if (insertErr) {
                                                                console.error('Create auction error:', insertErr);
                                                                sendJson(res, 500, {
                                                                    message: 'Could not start the auction.'
                                                                });
                                                                return;
                                                            }

                                                            
                                                            if (io) {
                                                                io.to(`game:${gameId}`).emit('auctionStarted', {
                                                                    gameId,
                                                                    auctionId: result.insertId,
                                                                    propertyId: property.property_id,
                                                                    propertyName: property.property_name,
                                                                    startingPlayerId: player.player_id,
                                                                    endsAt: new Date(Date.now() + 30000).toISOString()
                                                                });
                                                            }


                                                            sendJson(res, 201, {
                                                                message: 'Auction started successfully!',
                                                                auctionId: result.insertId,
                                                                propertyId: property.property_id,
                                                                propertyName: property.property_name,
                                                                endsAt: new Date(Date.now() + 30000).toISOString()
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
                }
            );
        });

        return true;
    }

    
    // PLACE AUCTION BID
    if (req.method === 'POST' && route === '/games/auction/bid') {
        const session = getSession(req);

        if (!session) {
            sendJson(res, 401, {
                message: 'Please log in to bid.'
            });
            return true;
        }

        readJsonBody(req, res, requestData => {
            const gameId = Number(requestData.gameId);
            const auctionId = Number(requestData.auctionId);
            const bid = Number(requestData.bid);

            if (
                !Number.isSafeInteger(gameId) ||
                gameId <= 0 ||
                !Number.isSafeInteger(auctionId) ||
                auctionId <= 0 ||
                !Number.isFinite(bid) ||
                bid <= 0 ||
                Math.round(bid * 100) !== bid * 100
            ) {
                sendJson(res, 400, {
                    message: 'Enter a valid game, auction, and bid amount.'
                });
                return;
            }

            db.query(
                `SELECT player_id, player_name, money
                 FROM Player
                 WHERE game_id = ?
                   AND user_id = ?
                   AND is_bankrupt = 0`,
                [gameId, session.userId],
                (playerErr, players) => {
                    if (playerErr) {
                        console.error('Auction bidder lookup error:', playerErr);
                        sendJson(res, 500, {
                            message: 'Could not find your player.'
                        });
                        return;
                    }

                    if (players.length === 0) {
                        sendJson(res, 403, {
                            message: 'You are not an active player in this game.'
                        });
                        return;
                    }

                    const player = players[0];

                    db.query(
                        `SELECT auction_id, property_id, highest_bid,
                                highest_bidder_id, auction_status, ends_at
                         FROM Property_Auction
                         WHERE auction_id = ? AND game_id = ?`,
                        [auctionId, gameId],
                        (auctionErr, auctions) => {
                            if (auctionErr) {
                                console.error('Auction lookup error:', auctionErr);
                                sendJson(res, 500, {
                                    message: 'Could not load the auction.'
                                });
                                return;
                            }

                            if (
                                auctions.length === 0 ||
                                auctions[0].auction_status !== 'open'
                            ) {
                                sendJson(res, 409, {
                                    message: 'This auction is not open.'
                                });
                                return;
                            }

                            const auction = auctions[0];

                            if (new Date(auction.ends_at).getTime() <= Date.now()) {
                                sendJson(res, 409, {
                                    message: 'The bidding time has expired.'
                                });
                                return;
                            }

                            if (Number(player.money) < bid) {
                                sendJson(res, 400, {
                                    message: 'You do not have enough money for this bid.'
                                });
                                return;
                            }

                            if (bid <= Number(auction.highest_bid)) {
                                sendJson(res, 400, {
                                    message: 'Your bid must be higher than the current highest bid.'
                                });
                                return;
                            }

                            if (
                                Number(auction.highest_bidder_id) ===
                                Number(player.player_id)
                            ) {
                                sendJson(res, 409, {
                                    message: 'You already have the highest bid.'
                                });
                                return;
                            }

                            db.query(
                                `UPDATE Property_Auction
                                 SET highest_bid = ?,
                                     highest_bidder_id = ?
                                 WHERE auction_id = ?
                                   AND game_id = ?
                                   AND auction_status = 'open'
                                   AND ends_at > NOW()
                                   AND highest_bid < ?`,
                                [
                                    bid,
                                    player.player_id,
                                    auctionId,
                                    gameId,
                                    bid
                                ],
                                (updateErr, result) => {
                                    if (updateErr) {
                                        console.error('Save auction bid error:', updateErr);
                                        sendJson(res, 500, {
                                            message: 'Could not save your bid.'
                                        });
                                        return;
                                    }

                                    if (result.affectedRows === 0) {
                                        sendJson(res, 409, {
                                            message: 'The auction changed or expired. Refresh and try again.'
                                        });
                                        return;
                                    }

                                    
                                    if (io) {
                                        io.to(`game:${gameId}`).emit('auctionBidUpdated', {
                                            gameId,
                                            auctionId,
                                            highestBid: bid,
                                            highestBidderId: player.player_id,
                                            highestBidderName: player.player_name
                                        });
                                    }


                                    sendJson(res, 200, {
                                        message: 'Bid placed successfully!',
                                        auctionId,
                                        highestBid: bid,
                                        highestBidderId: player.player_id
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

    
    // FINISH PROPERTY AUCTION
    if (req.method === 'POST' && route === '/games/auction/finish') {
        const session = getSession(req);

        if (!session) {
            sendJson(res, 401, {
                message: 'Please log in to finish an auction.'
            });
            return true;
        }

        readJsonBody(req, res, requestData => {
            const gameId = Number(requestData.gameId);
            const auctionId = Number(requestData.auctionId);

            if (
                !Number.isSafeInteger(gameId) || gameId <= 0 ||
                !Number.isSafeInteger(auctionId) || auctionId <= 0
            ) {
                sendJson(res, 400, {
                    message: 'Invalid game or auction ID.'
                });
                return;
            }

            // Verify that the requester is an active player in this game.
            db.query(
                `SELECT player_id
                 FROM Player
                 WHERE game_id = ?
                   AND user_id = ?
                   AND is_bankrupt = 0`,
                [gameId, session.userId],
                (playerErr, players) => {
                    if (playerErr) {
                        console.error('Auction finisher lookup error:', playerErr);
                        sendJson(res, 500, {
                            message: 'Could not verify your player.'
                        });
                        return;
                    }

                    if (players.length === 0) {
                        sendJson(res, 403, {
                            message: 'You are not an active player in this game.'
                        });
                        return;
                    }

                    db.beginTransaction(transactionErr => {
                        if (transactionErr) {
                            console.error('Auction transaction error:', transactionErr);
                            sendJson(res, 500, {
                                message: 'Could not begin auction finalization.'
                            });
                            return;
                        }

                        db.query(
                            `SELECT auction_id, property_id, starting_player_id,
                                    highest_bid, highest_bidder_id,
                                    auction_status, ends_at
                             FROM Property_Auction
                             WHERE auction_id = ? AND game_id = ?
                             FOR UPDATE`,
                            [auctionId, gameId],
                            (auctionErr, auctions) => {
                                if (auctionErr || auctions.length === 0) {
                                    return db.rollback(() => {
                                        console.error(
                                            'Auction lookup error:',
                                            auctionErr
                                        );

                                        sendJson(res, auctionErr ? 500 : 404, {
                                            message: auctionErr
                                                ? 'Could not load the auction.'
                                                : 'Auction not found.'
                                        });
                                    });
                                }

                                const auction = auctions[0];

                                if (auction.auction_status !== 'open') {
                                    return db.rollback(() => {
                                        sendJson(res, 409, {
                                            message: 'This auction has already finished.'
                                        });
                                    });
                                }

                                if (
                                    !auction.ends_at ||
                                    new Date(auction.ends_at).getTime() > Date.now()
                                ) {
                                    return db.rollback(() => {
                                        sendJson(res, 409, {
                                            message: 'The auction timer has not expired yet.'
                                        });
                                    });
                                }

                                // NO BIDS: close the auction and end the starter's turn.
                                if (!auction.highest_bidder_id) {
                                    db.query(
                                        `UPDATE Property_Auction
                                         SET auction_status = 'no_bids'
                                         WHERE auction_id = ?
                                           AND auction_status = 'open'`,
                                        [auctionId],
                                        updateErr => {
                                            if (updateErr) {
                                                return db.rollback(() => {
                                                    console.error(
                                                        'Close no-bid auction error:',
                                                        updateErr
                                                    );

                                                    sendJson(res, 500, {
                                                        message: 'Could not close the auction.'
                                                    });
                                                });
                                            }

                                            advanceAuctionTurn(
                                                db,
                                                gameId,
                                                auction.starting_player_id,
                                                (turnErr, turnAdvanced) => {
                                                    if (turnErr) {
                                                        return db.rollback(() => {
                                                            console.error(
                                                                'Advance auction turn error:',
                                                                turnErr
                                                            );

                                                            sendJson(res, 500, {
                                                                message: 'Could not advance the turn after the auction.'
                                                            });
                                                        });
                                                    }

                                                    db.commit(commitErr => {
                                                        if (commitErr) {
                                                            return db.rollback(() => {
                                                                console.error(
                                                                    'Auction commit error:',
                                                                    commitErr
                                                                );

                                                                sendJson(res, 500, {
                                                                    message: 'Could not save the auction result.'
                                                                });
                                                            });
                                                        }

                                                        if (io) {
                                                            io.to(`game:${gameId}`).emit(
                                                                'auctionFinished',
                                                                {
                                                                    gameId,
                                                                    auctionId,
                                                                    propertyId: auction.property_id,
                                                                    propertyName: null,
                                                                    winnerPlayerId: null,
                                                                    winnerPlayerName: null,
                                                                    winningBid: 0,
                                                                    status: 'no_bids',
                                                                    turnAdvanced
                                                                }
                                                            );
                                                        }

                                                        sendJson(res, 200, {
                                                            message: 'Auction ended with no bids.',
                                                            auctionId,
                                                            status: 'no_bids',
                                                            turnAdvanced
                                                        });
                                                    });
                                                }
                                            );
                                        }
                                    );

                                    return;
                                }

                                // Look up the winner and property names.
                                db.query(
                                    `SELECT
                                        Player.player_name,
                                        Property.property_name
                                     FROM Player
                                     JOIN Property
                                       ON Property.property_id = ?
                                     WHERE Player.player_id = ?
                                       AND Player.game_id = ?`,
                                    [
                                        auction.property_id,
                                        auction.highest_bidder_id,
                                        gameId
                                    ],
                                    (winnerErr, winnerRows) => {
                                        if (winnerErr || winnerRows.length === 0) {
                                            return db.rollback(() => {
                                                console.error(
                                                    'Auction winner lookup error:',
                                                    winnerErr
                                                );

                                                sendJson(res, 500, {
                                                    message: 'Could not find the auction winner.'
                                                });
                                            });
                                        }

                                        const winnerPlayerName =
                                            winnerRows[0].player_name;

                                        const propertyName =
                                            winnerRows[0].property_name;

                                        // Deduct the winning bid.
                                        db.query(
                                            `UPDATE Player
                                             SET money = money - ?
                                             WHERE player_id = ?
                                               AND game_id = ?
                                               AND is_bankrupt = 0
                                               AND money >= ?`,
                                            [
                                                auction.highest_bid,
                                                auction.highest_bidder_id,
                                                gameId,
                                                auction.highest_bid
                                            ],
                                            (paymentErr, paymentResult) => {

                                                console.log('Auction payment error:', paymentErr);
                                                console.log('Winning bid:', auction.highest_bid);
                                                console.log('Winning player ID:', auction.highest_bidder_id);
                                                console.log('Rows updated:', paymentResult?.affectedRows);
                                                if (
                                                    paymentErr ||
                                                    paymentResult.affectedRows !== 1
                                                ) {
                                                    return db.rollback(() => {
                                                        console.error(
                                                            'Auction payment error:',
                                                            paymentErr
                                                        );

                                                        sendJson(res, 409, {
                                                            message:
                                                                'The winning bidder no longer has enough money. The auction was not finalized.'
                                                        });
                                                    });
                                                }

                                                // Award the property to the winner.
                                                db.query(
                                                    `INSERT INTO Player_Property
                                                        (player_id, property_id)
                                                     VALUES (?, ?)`,
                                                    [
                                                        auction.highest_bidder_id,
                                                        auction.property_id
                                                    ],
                                                    propertyErr => {
                                                        if (propertyErr) {
                                                            return db.rollback(() => {
                                                                console.error(
                                                                    'Award auction property error:',
                                                                    propertyErr
                                                                );

                                                                sendJson(res, 500, {
                                                                    message: 'Could not award the property.'
                                                                });
                                                            });
                                                        }

                                                        // Mark the auction completed.
                                                        db.query(
                                                            `UPDATE Property_Auction
                                                             SET auction_status = 'completed'
                                                             WHERE auction_id = ?
                                                               AND auction_status = 'open'`,
                                                            [auctionId],
                                                            (statusErr, statusResult) => {
                                                                if (
                                                                    statusErr ||
                                                                    statusResult.affectedRows !== 1
                                                                ) {
                                                                    return db.rollback(() => {
                                                                        console.error(
                                                                            'Update auction status error:',
                                                                            statusErr
                                                                        );

                                                                        sendJson(res, 500, {
                                                                            message: 'Could not save the auction result.'
                                                                        });
                                                                    });
                                                                }

                                                                // End the auction starter's turn.
                                                                advanceAuctionTurn(
                                                                    db,
                                                                    gameId,
                                                                    auction.starting_player_id,
                                                                    (turnErr, turnAdvanced) => {
                                                                        if (turnErr) {
                                                                            return db.rollback(() => {
                                                                                console.error(
                                                                                    'Advance auction turn error:',
                                                                                    turnErr
                                                                                );

                                                                                sendJson(res, 500, {
                                                                                    message: 'Could not advance the turn after the auction.'
                                                                                });
                                                                            });
                                                                        }

                                                                        // Commit the auction and turn update together.
                                                                        db.commit(commitErr => {
                                                                            if (commitErr) {
                                                                                return db.rollback(() => {
                                                                                    console.error(
                                                                                        'Auction commit error:',
                                                                                        commitErr
                                                                                    );

                                                                                    sendJson(res, 500, {
                                                                                        message: 'Could not save the auction result.'
                                                                                    });
                                                                                });
                                                                            }

                                                                            if (io) {
                                                                                io.to(`game:${gameId}`).emit(
                                                                                    'auctionFinished',
                                                                                    {
                                                                                        gameId,
                                                                                        auctionId,
                                                                                        propertyId: auction.property_id,
                                                                                        propertyName,
                                                                                        winnerPlayerId:
                                                                                            auction.highest_bidder_id,
                                                                                        winnerPlayerName,
                                                                                        winningBid: Number(
                                                                                            auction.highest_bid
                                                                                        ),
                                                                                        status: 'completed',
                                                                                        turnAdvanced
                                                                                    }
                                                                                );
                                                                            }

                                                                            sendJson(res, 200, {
                                                                                message:
                                                                                    'Auction finished and property awarded!',
                                                                                auctionId,
                                                                                propertyId: auction.property_id,
                                                                                propertyName,
                                                                                winnerPlayerId:
                                                                                    auction.highest_bidder_id,
                                                                                winnerPlayerName,
                                                                                winningBid: Number(
                                                                                    auction.highest_bid
                                                                                ),
                                                                                status: 'completed',
                                                                                turnAdvanced
                                                                            });
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
                            }
                        );
                    });
                }
            );
        });

        return true;
    }

    // BUY PROPERTY
if (req.method === 'POST' && route === '/games/buy-property') {
    const session = getSession(req);

    if (!session) {
        sendJson(res, 401, {
            message: 'Please log in to buy a property.'
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
                    sendJson(res, 400, {
                        message: 'This game is not currently in progress.'
                    });
                    return;
                }

                purchaseProperty(
                    db,
                    session.userId,
                    gameId,
                    (purchaseErr, property) => {
                        if (purchaseErr) {
                            const message = purchaseErr.message;

                            if (
                                message ===
                                    'There is no purchasable property at this position.' ||
                                message ===
                                    'This property is already owned.' ||
                                message ===
                                    'You do not have enough money to buy this property.'
                            ) {
                                sendJson(res, 409, { message });
                                return;
                            }

                            if (
                                message ===
                                'You are not an active player in this game.'
                            ) {
                                sendJson(res, 403, { message });
                                return;
                            }

                            console.error('Purchase property error:', purchaseErr);
                            sendJson(res, 500, {
                                message: 'Could not purchase the property.'
                            });
                            return;
                        }

                        if (io) {
                            io.to(`game:${gameId}`).emit('propertyPurchased', {
                                gameId,
                                propertyId: property.propertyId,
                                propertyName: property.propertyName,
                                playerName: property.playerName
                            });
                        }

                        sendJson(res, 200, {
                            message: `You purchased ${property.propertyName}!`,
                            property
                        });
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
                                `SELECT player_id
                                FROM Player
                                WHERE game_id = ?
                                ORDER BY player_id ASC
                                LIMIT 1`,
                                [gameId],
                                (firstPlayerErr, firstPlayers) => {
                                    if (firstPlayerErr) {
                                        console.error('Find first player error:', firstPlayerErr);
                                        sendJson(res, 500, {
                                            message: 'Could not select the first player.'
                                        });
                                        return;
                                    }

                                    if (firstPlayers.length === 0) {
                                        sendJson(res, 400, {
                                            message: 'No players are available to start the game.'
                                        });
                                        return;
                                    }

                                    const firstPlayerId = firstPlayers[0].player_id;

                                    db.query(
                                        `UPDATE Game
                                        SET game_status = 'in_progress',
                                            current_player_id = ?,
                                            gamestarted_at = CURRENT_TIMESTAMP
                                        WHERE game_id = ?
                                        AND game_status = 'waiting'`,
                                        [firstPlayerId, gameId],
                                        (updateErr, result) => {
                                            if (updateErr) {
                                                console.error('Start game error:', updateErr);
                                                sendJson(res, 500, {
                                                    message: 'Could not start the game.'
                                                });
                                                return;
                                            }

                                            if (result.affectedRows === 0) {
                                                sendJson(res, 409, {
                                                    message: 'The game has already started.'
                                                });
                                                return;
                                            }

                                            if (io) {
                                                io.to(`game:${gameId}`).emit('gameStarted', {
                                                    gameId,
                                                    currentPlayerId: firstPlayerId
                                                });
                                            }

                                            sendJson(res, 200, {
                                                message: 'Game started successfully!',
                                                gameId,
                                                currentPlayerId: firstPlayerId
                                            });
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

    
if (req.method === 'POST' && route === '/games/end-turn') {
    console.log('END-TURN ROUTE REACHED');
    const session = getSession(req);

    if (!session) {
        sendJson(res, 401, {
            message: 'You must be logged in.'
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
            `SELECT current_player_id, game_status
             FROM Game
             WHERE game_id = ?`,
            [gameId],
            (err, games) => {
                if (err) {
                    console.error('End turn error:', err);
                    sendJson(res, 500, {
                        message: 'Could not end turn.'
                    });
                    return;
                }

                if (
                    games.length === 0 ||
                    games[0].game_status !== 'in_progress'
                ) {
                    sendJson(res, 400, {
                        message: 'This game is not in progress.'
                    });
                    return;
                }

                const currentPlayerId = games[0].current_player_id;

                db.query(
                    `SELECT player_id
                     FROM Player
                     WHERE player_id = ?
                       AND game_id = ?
                       AND user_id = ?
                       AND is_bankrupt = 0`,
                    [currentPlayerId, gameId, session.userId],
                    (playerErr, players) => {
                        if (playerErr) {
                            console.error('End turn player error:', playerErr);
                            sendJson(res, 500, {
                                message: 'Could not verify the current player.'
                            });
                            return;
                        }

                        if (players.length === 0) {
                            sendJson(res, 403, {
                                message: 'It is not your turn.'
                            });
                            return;
                        }

                        getNextPlayer(
                            db,
                            gameId,
                            currentPlayerId,
                            (nextErr, nextPlayerId) => {
                                if (nextErr) {
                                    console.error('Next player error:', nextErr);
                                    sendJson(res, 500, {
                                        message: 'Could not find the next player.'
                                    });
                                    return;
                                }

                                console.log('Current player ID:', currentPlayerId);
                                console.log('Next player ID:', nextPlayerId);

                                db.query(
                                    `UPDATE Game
                                     SET current_player_id = ?
                                     WHERE game_id = ?
                                       AND current_player_id = ?`,
                                    [nextPlayerId, gameId, currentPlayerId],
                                    (updateErr, result) => {
                                        if (updateErr) {
                                            console.error('Advance turn error:', updateErr);
                                            sendJson(res, 500, {
                                                message: 'Could not advance the turn.'
                                            });
                                            return;
                                        }

                                        if (result.affectedRows === 0) {
                                            sendJson(res, 409, {
                                                message: 'The turn has already changed.'
                                            });
                                            return;
                                        }

                                        sendJson(res, 200, {
                                            message: 'Turn ended successfully.',
                                            currentPlayerId: nextPlayerId
                                        });
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


    return false;
}

module.exports = handleGameRequest;
function handleGameLobbyRequest(req, res, { db, getSession, sendJson, readJsonBody, io }) {
    const route = req.url.split('?')[0];

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
            `SELECT game_id, game_status, player_count, host_user_id, current_player_id
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

    return false;
}

module.exports = handleGameLobbyRequest;


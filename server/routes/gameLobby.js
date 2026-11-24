function handleGameLobbyRequest(req, res, { db, getSession, sendJson, readJsonBody, io }) {
    const route = req.url.split('?')[0];

    if (req.method === 'GET' && route === '/games/local/saved') {
        const session = getSession(req);
        if (!session) {
            sendJson(res, 401, { message: 'Please log in to view local games.' });
            return true;
        }

        db.query(
            `SELECT
                Game.game_id,
                Game.player_count,
                Game.game_status,
                Game.saved_at,
                CurrentPlayer.player_name AS current_player_name
             FROM Game
             LEFT JOIN Player AS CurrentPlayer
               ON CurrentPlayer.player_id = Game.current_player_id
              AND CurrentPlayer.game_id = Game.game_id
             WHERE Game.game_mode = 'local'
               AND Game.game_status = 'in_progress'
               AND Game.is_saved = 1
               AND Game.host_user_id = ?
             ORDER BY Game.saved_at DESC, Game.game_id DESC`,
            [session.userId],
            (error, games) => {
                if (error) {
                    console.error('Load saved local games error:', error);
                    sendJson(res, 500, { message: 'Could not load saved local games.' });
                    return;
                }
                sendJson(res, 200, { games });
            }
        );
        return true;
    }

    if (
        req.method === 'POST' &&
        (route === '/games/local/save' || route === '/games/local/leave')
    ) {
        const session = getSession(req);
        if (!session) {
            sendJson(res, 401, { message: 'Please log in to save this local game.' });
            return true;
        }

        readJsonBody(req, res, requestData => {
            const gameId = Number(requestData.gameId);
            if (!Number.isSafeInteger(gameId) || gameId <= 0) {
                sendJson(res, 400, { message: 'Invalid game ID.' });
                return;
            }

            if (route === '/games/local/leave') {
                db.query(
                    `SELECT game_id
                     FROM Game
                     WHERE game_id = ?
                       AND host_user_id = ?
                       AND game_mode = 'local'
                       AND game_status = 'in_progress'`,
                    [gameId, session.userId],
                    (error, games) => {
                        if (error) {
                            console.error('Leave local game error:', error);
                            sendJson(res, 500, { message: 'Could not leave this local game.' });
                            return;
                        }
                        if (games.length === 0) {
                            sendJson(res, 404, {
                                message: 'This active local game could not be found.'
                            });
                            return;
                        }
                        sendJson(res, 200, {
                            message: 'You left the local game. It will appear here only if you saved it.'
                        });
                    }
                );
                return;
            }

            db.query(
                `UPDATE Game
                 SET is_saved = 1,
                     saved_at = CURRENT_TIMESTAMP
                 WHERE game_id = ?
                   AND host_user_id = ?
                   AND game_mode = 'local'
                   AND game_status = 'in_progress'`,
                [gameId, session.userId],
                (error, result) => {
                    if (error) {
                        console.error('Save local game error:', error);
                        sendJson(res, 500, { message: 'Could not save this local game.' });
                        return;
                    }
                    if (result.affectedRows !== 1) {
                        sendJson(res, 404, {
                            message: 'This active local game could not be found.'
                        });
                        return;
                    }

                    sendJson(res, 200, {
                        message: route === '/games/local/leave'
                            ? 'Local game saved. You can resume it from the local lobby.'
                            : 'Local game saved.'
                    });
                }
            );
        });
        return true;
    }

    if (req.method === 'POST' && route === '/games/local/start') {
        const session = getSession(req);

        if (!session) {
            sendJson(res, 401, { message: 'Please log in before starting a local game.' });
            return true;
        }

        readJsonBody(req, res, requestData => {
            const requestedPlayers = requestData.players;
            const allowedTokens = new Set([
                'top_hat', 'race_car', 'dog', 'battleship', 'thimble',
                'boot', 'cat', 'wheelbarrow', 'duck', 'windmill'
            ]);
            if (
                !Array.isArray(requestedPlayers) ||
                requestedPlayers.length < 2 ||
                requestedPlayers.length > 4 ||
                requestedPlayers.some(player =>
                    !player ||
                    !Number.isSafeInteger(player.playerNumber) ||
                    player.playerNumber < 1 ||
                    player.playerNumber > 4 ||
                    typeof player.name !== 'string' ||
                    player.name.trim().length === 0 ||
                    player.name.trim().length > 45 ||
                    !allowedTokens.has(player.tokenType)
                )
            ) {
                sendJson(res, 400, {
                    message: 'Add 2 to 4 players and choose a valid token for each one.'
                });
                return;
            }

            const playerNames = [...requestedPlayers].sort(
                (first, second) => first.playerNumber - second.playerNumber
            );
            if (new Set(playerNames.map(player => player.playerNumber)).size !== playerNames.length) {
                sendJson(res, 400, { message: 'Each player must have a unique player number.' });
                return;
            }
            if (playerNames.some((player, index) => player.playerNumber !== index + 1)) {
                sendJson(res, 400, { message: 'Player numbers must be in order from 1.' });
                return;
            }
            const normalizedNames = playerNames.map(player => player.name.trim());
            const distinctNames = new Set(
                normalizedNames.map(name => name.toLocaleLowerCase())
            );
            if (distinctNames.size !== normalizedNames.length) {
                sendJson(res, 400, { message: 'Each player needs a different name.' });
                return;
            }

            const distinctTokens = new Set(playerNames.map(player => player.tokenType));
            if (distinctTokens.size !== playerNames.length) {
                sendJson(res, 400, { message: 'Each player must choose a different token.' });
                return;
            }

            if (
                normalizedNames[0].toLocaleLowerCase() !==
                String(session.username).toLocaleLowerCase()
            ) {
                sendJson(res, 400, { message: 'The logged-in player must be Player 1.' });
                return;
            }

            db.getConnection((connectionErr, connection) => {
                if (connectionErr) {
                    sendJson(res, 500, { message: 'Could not create the local game.' });
                    return;
                }

                connection.beginTransaction(async beginErr => {
                    if (beginErr) {
                        connection.release();
                        sendJson(res, 500, { message: 'Could not create the local game.' });
                        return;
                    }

                    const query = (sql, values = []) => new Promise((resolve, reject) => {
                        connection.query(sql, values, (error, result) => {
                            if (error) reject(error);
                            else resolve(result);
                        });
                    });

                    try {
                        const gameResult = await query(
                            `INSERT INTO Game
                                (game_status, game_mode, player_count, host_user_id)
                             VALUES ('waiting', 'local', ?, ?)`,
                            [normalizedNames.length, session.userId]
                        );
                        const gameId = Number(gameResult.insertId);

                        for (let index = 0; index < normalizedNames.length; index += 1) {
                            await query(
                                `INSERT INTO Player
                                    (player_name, user_id, game_id, token_type, token_locked)
                                 VALUES (?, ?, ?, ?, 1)`,
                                [
                                    normalizedNames[index],
                                    session.userId,
                                    gameId,
                                    playerNames[index].tokenType
                                ]
                            );
                        }

                        const firstPlayers = await query(
                            `SELECT player_id
                             FROM Player
                             WHERE game_id = ?
                             ORDER BY player_id ASC
                             LIMIT 1`,
                            [gameId]
                        );
                        if (firstPlayers.length !== 1) {
                            throw new Error('Could not determine the first local player.');
                        }
                        const firstPlayerId = Number(firstPlayers[0].player_id);

                        await query(
                            `UPDATE Game
                             SET game_status = 'in_progress',
                                 current_player_id = ?,
                                 gamestarted_at = CURRENT_TIMESTAMP
                             WHERE game_id = ?`,
                            [firstPlayerId, gameId]
                        );

                        await new Promise((resolve, reject) => {
                            connection.commit(error => {
                                if (error) reject(error);
                                else resolve();
                            });
                        });
                        connection.release();
                        sendJson(res, 201, {
                            message: 'Local game started.',
                            gameId,
                            playerCount: normalizedNames.length
                        });
                    } catch (error) {
                        connection.rollback(() => {
                            connection.release();
                            console.error('Create local game error:', error);
                            sendJson(res, 500, {
                                message: 'Could not create the local game.'
                            });
                        });
                    }
                });
            });
        });

        return true;
    }

    if (req.method === 'GET' && route === '/games/my-stats') {
        const session = getSession(req);

        if (!session) {
            sendJson(res, 401, {
                message: 'Please log in to view your player stats.'
            });
            return true;
        }

        const userId = Number(session.userId);

        db.query(
            `SELECT
                 (
                     SELECT COUNT(*)
                     FROM Player AS p
                     JOIN Game AS g ON g.game_id = p.game_id
                     WHERE p.user_id = ?
                       AND g.gamestarted_at IS NOT NULL
                 ) AS games_played,
                 (
                     SELECT COUNT(*)
                     FROM Player AS p
                     JOIN Game AS g ON g.game_id = p.game_id
                     WHERE p.user_id = ?
                       AND g.game_status = 'completed'
                       AND g.current_player_id = p.player_id
                 ) AS games_won,
                 (
                     SELECT p.token_type
                     FROM Player AS p
                     JOIN Game AS g ON g.game_id = p.game_id
                     WHERE p.user_id = ?
                       AND g.gamestarted_at IS NOT NULL
                       AND p.token_type IS NOT NULL
                     GROUP BY p.token_type
                     ORDER BY COUNT(*) DESC, p.token_type ASC
                     LIMIT 1
                 ) AS most_picked_piece,
                 (
                     SELECT COALESCE(SUM(gt.amount), 0)
                     FROM Game_Transaction AS gt
                     JOIN Player AS p ON p.player_id = gt.player_id
                     WHERE p.user_id = ?
                       AND gt.game_id = p.game_id
                       AND gt.amount > 0
                 ) AS total_money_earned,
                 (
                     SELECT COUNT(*)
                     FROM Game_Transaction AS gt
                     JOIN Player AS p ON p.player_id = gt.player_id
                     WHERE p.user_id = ?
                       AND gt.game_id = p.game_id
                       AND gt.transaction_type = 'House Purchase'
                 ) AS houses_bought,
                 (
                     SELECT COUNT(*)
                     FROM Game_Transaction AS gt
                     JOIN Player AS p ON p.player_id = gt.player_id
                     WHERE p.user_id = ?
                       AND gt.game_id = p.game_id
                       AND gt.transaction_type = 'Hotel Purchase'
                 ) AS hotels_bought,
                 (
                     SELECT COALESCE(SUM(p.times_jailed), 0)
                     FROM Player AS p
                     WHERE p.user_id = ?
                 ) AS times_jailed`,
            [userId, userId, userId, userId, userId, userId, userId],
            (statsErr, rows) => {
                if (statsErr) {
                    console.error('Load player stats error:', statsErr);
                    sendJson(res, 500, {
                        message: 'Could not load your player stats.'
                    });
                    return;
                }

                sendJson(res, 200, {
                    playerName: session.username,
                    stats: rows[0] || {
                        games_played: 0,
                        games_won: 0,
                        most_picked_piece: null,
                        total_money_earned: 0,
                        houses_bought: 0,
                        hotels_bought: 0,
                        times_jailed: 0
                    }
                });
            }
        );

        return true;
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
            `SELECT game_id, game_status, game_mode, player_count, host_user_id, current_player_id, turn_has_rolled
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
                    `SELECT player_id, user_id, player_name, money, position, token_type, consecutive_doubles, is_bankrupt, is_in_jail, jail_free_cards, jail_turns
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
                                        Property.board_position,
                                        Property.property_type,
                                        Property.price,
                                        Property.rent,
                                        Property.color_group,
                                        Property.house_cost,
                                        Property.hotel_cost,
                                        CurrentOwnership.player_id,
                                        CurrentOwnership.houses,
                                        CurrentOwnership.hotels,
                                        CurrentOwnership.mortgaged
                                    FROM Property
                                    LEFT JOIN (
                                        SELECT
                                            Player_Property.property_id,
                                            Player_Property.player_id,
                                            Player_Property.houses,
                                            Player_Property.hotels,
                                            Player_Property.mortgaged
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

                                        db.query(
                                            `SELECT
                                                 debt.pending_debt_id,
                                                 debt.debtor_player_id,
                                                 debt.creditor_player_id,
                                                 debt.amount_due,
                                                 debt.debt_source,
                                                 debtor.player_name AS debtor_name,
                                                 creditor.player_name AS creditor_name
                                             FROM Pending_Debt AS debt
                                             JOIN Player AS debtor
                                               ON debtor.player_id = debt.debtor_player_id
                                              AND debtor.game_id = debt.game_id
                                             LEFT JOIN Player AS creditor
                                               ON creditor.player_id = debt.creditor_player_id
                                              AND creditor.game_id = debt.game_id
                                             WHERE debt.game_id = ?
                                             ORDER BY debt.pending_debt_id`,
                                            [gameId],
                                            (debtErr, pendingDebts) => {
                                                if (debtErr) {
                                                    console.error('Load pending debts error:', debtErr);
                                                    sendJson(res, 500, {
                                                        message: 'Could not load pending debts.'
                                                    });
                                                    return;
                                                }

                                                db.query(
                                                    `SELECT
                                                         auction.auction_id,
                                                         auction.property_id,
                                                         auction.highest_bid,
                                                         auction.highest_bidder_id,
                                                         auction.ends_at,
                                                         property.property_name,
                                                         bidder.player_name AS highest_bidder_name
                                                     FROM Property_Auction AS auction
                                                     JOIN Property AS property
                                                       ON property.property_id = auction.property_id
                                                     LEFT JOIN Player AS bidder
                                                       ON bidder.player_id = auction.highest_bidder_id
                                                      AND bidder.game_id = auction.game_id
                                                     WHERE auction.game_id = ?
                                                       AND auction.auction_status = 'open'
                                                     LIMIT 1`,
                                                    [gameId],
                                                    (auctionErr, auctions) => {
                                                        if (auctionErr) {
                                                            console.error('Load active local auction error:', auctionErr);
                                                            sendJson(res, 500, {
                                                                message: 'Could not load the active auction.'
                                                            });
                                                            return;
                                                        }

                                                        sendJson(res, 200, {
                                                            game: games[0],
                                                            players,
                                                            properties,
                                                            pendingDebts,
                                                            activeAuction: auctions[0] || null,
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
                    }
                );
            }
        );

        return true;
    }

    return false;
}

module.exports = handleGameLobbyRequest;


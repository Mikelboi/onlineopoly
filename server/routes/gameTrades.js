const { declareBankruptcyAtZero } = require('../Gameplay/bankrupt');

function handleGameTradeRequest(
    req,
    res,
    { db, getSession, sendJson, readJsonBody, io }
) {
    const route = req.url.split('?')[0];

    if (req.method === 'GET' && route === '/games/trades/pending') {
        const session = getSession(req);

        if (!session) {
            sendJson(res, 401, {
                message: 'Please log in to view trade offers.'
            });
            return true;
        }

        const gameId = Number(
            new URL(req.url, 'http://localhost').searchParams.get('gameId')
        );

        if (!Number.isSafeInteger(gameId) || gameId <= 0) {
            sendJson(res, 400, { message: 'Invalid game ID.' });
            return true;
        }

        db.query(
            `SELECT
                Trade_Offer.trade_id AS tradeId,
                Trade_Offer.offering_player_id AS offeringPlayerId,
                Trade_Offer.receiving_player_id AS receivingPlayerId,
                Trade_Offer.offering_cash AS offeringCash,
                Trade_Offer.receiving_cash AS receivingCash,
                Trade_Offer.created_at AS createdAt,
                OfferingPlayer.player_name AS offeringPlayerName,
                Trade_Offer_Property.property_id AS propertyId,
                Property.property_name AS propertyName,
                Trade_Offer_Property.property_giver_player_id AS giverPlayerId,
                GiverPlayer.player_name AS giverPlayerName
             FROM Trade_Offer
             JOIN Game ON Game.game_id = Trade_Offer.game_id
             JOIN Player AS ReceivingPlayer
               ON ReceivingPlayer.player_id =
                  Trade_Offer.receiving_player_id
              AND ReceivingPlayer.game_id = Trade_Offer.game_id
             JOIN Player AS OfferingPlayer
               ON OfferingPlayer.player_id =
                  Trade_Offer.offering_player_id
              AND OfferingPlayer.game_id = Trade_Offer.game_id
             LEFT JOIN Trade_Offer_Property
               ON Trade_Offer_Property.trade_id = Trade_Offer.trade_id
              AND Trade_Offer_Property.game_id = Trade_Offer.game_id
             LEFT JOIN Property
               ON Property.property_id =
                  Trade_Offer_Property.property_id
             LEFT JOIN Player AS GiverPlayer
               ON GiverPlayer.player_id =
                  Trade_Offer_Property.property_giver_player_id
              AND GiverPlayer.game_id = Trade_Offer.game_id
             WHERE Trade_Offer.game_id = ?
               AND (
                    (Game.game_mode = 'local' AND Game.host_user_id = ?)
                    OR
                    (Game.game_mode <> 'local' AND ReceivingPlayer.user_id = ?)
               )
               AND Trade_Offer.status = 'pending'
             ORDER BY Trade_Offer.created_at`,
            [gameId, Number(session.userId), Number(session.userId)],
            (error, rows) => {
                if (error) {
                    console.error('Load pending trade offers error:', error);
                    sendJson(res, 500, {
                        message: 'Could not load pending trade offers.'
                    });
                    return;
                }

                const offersById = new Map();

                rows.forEach(row => {
                    if (!offersById.has(row.tradeId)) {
                        offersById.set(row.tradeId, {
                            tradeId: row.tradeId,
                            offeringPlayerId: row.offeringPlayerId,
                            receivingPlayerId: row.receivingPlayerId,
                            offeringPlayerName: row.offeringPlayerName,
                            offeringCash: row.offeringCash,
                            receivingCash: row.receivingCash,
                            createdAt: row.createdAt,
                            properties: []
                        });
                    }

                    if (row.propertyId !== null) {
                        offersById.get(row.tradeId).properties.push({
                            propertyId: row.propertyId,
                            propertyName: row.propertyName,
                            giverPlayerId: row.giverPlayerId,
                            giverPlayerName: row.giverPlayerName
                        });
                    }
                });

                sendJson(res, 200, {
                    offers: Array.from(offersById.values())
                });
            }
        );

        return true;
    }

    if (req.method === 'POST' && route === '/games/trades/respond') {
        const session = getSession(req);

        if (!session) {
            sendJson(res, 401, {
                message: 'Please log in to respond to trade offers.'
            });
            return true;
        }

        readJsonBody(req, res, requestData => {
            const gameId = Number(requestData.gameId);
            const tradeId = Number(requestData.tradeId);
            const action = requestData.action;
            const respondingPlayerId = Number(requestData.respondingPlayerId);

            if (
                !Number.isSafeInteger(gameId) ||
                gameId <= 0 ||
                !Number.isSafeInteger(tradeId) ||
                tradeId <= 0 ||
                !['accept', 'reject'].includes(action)
            ) {
                sendJson(res, 400, {
                    message: 'Invalid trade response.'
                });
                return;
            }

            db.getConnection((connectionErr, connection) => {
                if (connectionErr) {
                    sendJson(res, 500, {
                        message: 'Could not respond to the trade offer.'
                    });
                    return;
                }

                connection.beginTransaction(beginErr => {
                    if (beginErr) {
                        connection.release();
                        sendJson(res, 500, {
                            message: 'Could not respond to the trade offer.'
                        });
                        return;
                    }

                    let finished = false;

                    const fail = (status, message) => {
                        if (finished) return;
                        finished = true;

                        connection.rollback(() => {
                            connection.release();
                            sendJson(res, status, { message });
                        });
                    };

                    const query = (sql, values = []) =>
                        new Promise((resolve, reject) => {
                            connection.query(sql, values, (error, result) => {
                                if (error) {
                                    reject(error);
                                    return;
                                }

                                resolve(result);
                            });
                        });

                    (async () => {
                        const offers = await query(
                            `SELECT
                                Trade_Offer.trade_id,
                                Trade_Offer.game_id,
                                Trade_Offer.offering_player_id,
                                Trade_Offer.receiving_player_id,
                                Trade_Offer.offering_cash,
                                Trade_Offer.receiving_cash,
                                Trade_Offer.status
                             FROM Trade_Offer
                             JOIN Game ON Game.game_id = Trade_Offer.game_id
                             JOIN Player AS ReceivingPlayer
                               ON ReceivingPlayer.player_id =
                                  Trade_Offer.receiving_player_id
                              AND ReceivingPlayer.game_id =
                                  Trade_Offer.game_id
                             WHERE Trade_Offer.trade_id = ?
                               AND Trade_Offer.game_id = ?
                               AND (
                                    (Game.game_mode = 'local'
                                     AND Game.host_user_id = ?
                                     AND ReceivingPlayer.player_id = ?)
                                    OR
                                    (Game.game_mode <> 'local'
                                     AND ReceivingPlayer.user_id = ?)
                               )
                             FOR UPDATE`,
                            [
                                tradeId,
                                gameId,
                                Number(session.userId),
                                respondingPlayerId,
                                Number(session.userId)
                            ]
                        );

                        if (
                            offers.length === 0 ||
                            offers[0].status !== 'pending'
                        ) {
                            throw Object.assign(
                                new Error(
                                    'This trade offer is no longer available.'
                                ),
                                { status: 409 }
                            );
                        }

                        const offer = offers[0];
                        const offeringCash = Number(offer.offering_cash);
                        const receivingCash = Number(offer.receiving_cash);

                        if (action === 'reject') {
                            await query(
                                `UPDATE Trade_Offer
                                 SET status = 'rejected'
                                 WHERE trade_id = ?
                                   AND game_id = ?
                                   AND status = 'pending'`,
                                [tradeId, gameId]
                            );
                        } else {
                            const players = await query(
                                `SELECT player_id, money, is_bankrupt
                                 FROM Player
                                 WHERE game_id = ?
                                   AND player_id IN (?, ?)
                                 FOR UPDATE`,
                                [
                                    gameId,
                                    offer.offering_player_id,
                                    offer.receiving_player_id
                                ]
                            );

                            const offeringPlayer = players.find(
                                player =>
                                    Number(player.player_id) ===
                                    Number(offer.offering_player_id)
                            );
                            const receivingPlayer = players.find(
                                player =>
                                    Number(player.player_id) ===
                                    Number(offer.receiving_player_id)
                            );

                            if (
                                !offeringPlayer ||
                                !receivingPlayer ||
                                Number(offeringPlayer.is_bankrupt) === 1 ||
                                Number(receivingPlayer.is_bankrupt) === 1
                            ) {
                                throw Object.assign(
                                    new Error(
                                        'A player in this trade is no longer active.'
                                    ),
                                    { status: 409 }
                                );
                            }

                            if (
                                Number(offeringPlayer.money) < offeringCash ||
                                Number(receivingPlayer.money) < receivingCash
                            ) {
                                throw Object.assign(
                                    new Error(
                                        'A player no longer has enough cash to complete this trade.'
                                    ),
                                    { status: 409 }
                                );
                            }

                            const properties = await query(
                                `SELECT
                                    Trade_Offer_Property.property_id,
                                    Trade_Offer_Property.property_giver_player_id,
                                    Property.property_name,
                                    Player_Property.player_id AS owner_player_id,
                                    Player_Property.houses,
                                    Player_Property.hotels
                                 FROM Trade_Offer_Property
                                 LEFT JOIN Property
                                   ON Property.property_id =
                                      Trade_Offer_Property.property_id
                                 LEFT JOIN Player_Property
                                   ON Player_Property.property_id =
                                      Trade_Offer_Property.property_id
                                  AND Player_Property.player_id =
                                      Trade_Offer_Property.property_giver_player_id
                                 WHERE Trade_Offer_Property.trade_id = ?
                                   AND Trade_Offer_Property.game_id = ?
                                 FOR UPDATE`,
                                [tradeId, gameId]
                            );

                            for (const property of properties) {
                                if (
                                    Number(property.owner_player_id) !==
                                    Number(
                                        property.property_giver_player_id
                                    )
                                ) {
                                    throw Object.assign(
                                        new Error(
                                            `${property.property_name} is no longer ` +
                                            'owned by the player offering it.'
                                        ),
                                        { status: 409 }
                                    );
                                }

                                if (
                                    Number(property.houses) > 0 ||
                                    Number(property.hotels) > 0
                                ) {
                                    throw Object.assign(
                                        new Error(
                                            `Sell the buildings on ${property.property_name} ` +
                                            'before accepting this trade.'
                                        ),
                                        { status: 409 }
                                    );
                                }
                            }

                            await query(
                                `UPDATE Player
                                 SET money = money - ?
                                 WHERE player_id = ? AND game_id = ?`,
                                [
                                    offeringCash,
                                    offer.offering_player_id,
                                    gameId
                                ]
                            );

                            await query(
                                `UPDATE Player
                                 SET money = money + ?
                                 WHERE player_id = ? AND game_id = ?`,
                                [
                                    offeringCash,
                                    offer.receiving_player_id,
                                    gameId
                                ]
                            );

                            await query(
                                `UPDATE Player
                                 SET money = money - ?
                                 WHERE player_id = ? AND game_id = ?`,
                                [
                                    receivingCash,
                                    offer.receiving_player_id,
                                    gameId
                                ]
                            );

                            await query(
                                `UPDATE Player
                                 SET money = money + ?
                                 WHERE player_id = ? AND game_id = ?`,
                                [
                                    receivingCash,
                                    offer.offering_player_id,
                                    gameId
                                ]
                            );

                            for (const property of properties) {
                                const newOwnerId =
                                    Number(property.property_giver_player_id) ===
                                    Number(offer.offering_player_id)
                                        ? offer.receiving_player_id
                                        : offer.offering_player_id;

                                await query(
                                    `UPDATE Player_Property
                                     SET player_id = ?
                                     WHERE player_id = ?
                                       AND property_id = ?`,
                                    [
                                        newOwnerId,
                                        property.property_giver_player_id,
                                        property.property_id
                                    ]
                                );
                            }

                            await query(
                                `UPDATE Trade_Offer
                                 SET status = 'accepted'
                                 WHERE trade_id = ?
                                   AND game_id = ?
                                   AND status = 'pending'`,
                                [tradeId, gameId]
                            );
                        }

                        await new Promise((resolve, reject) => {
                            connection.commit(error => {
                                if (error) {
                                    reject(error);
                                    return;
                                }

                                resolve();
                            });
                        });

                        finished = true;
                        connection.release();

                        if (io) {
                            io.to(`game:${gameId}`).emit(
                                'tradeOfferResponded',
                                {
                                    gameId,
                                    tradeId,
                                    action
                                }
                            );
                        }

                        if (action !== 'accept') {
                            sendJson(res, 200, {
                                message: 'Trade offer rejected.'
                            });
                            return;
                        }

                        const possibleBankruptcies = [];
                        if (offeringCash > receivingCash) {
                            possibleBankruptcies.push({
                                playerId: Number(offer.offering_player_id),
                                creditorId: Number(offer.receiving_player_id)
                            });
                        }
                        if (receivingCash > offeringCash) {
                            possibleBankruptcies.push({
                                playerId: Number(offer.receiving_player_id),
                                creditorId: Number(offer.offering_player_id)
                            });
                        }

                        const processTradeBankruptcy = (index, bankruptcies) => {
                            if (index >= possibleBankruptcies.length) {
                                if (io && bankruptcies.length > 0) {
                                    bankruptcies.forEach(bankruptcy => {
                                        io.to(`game:${gameId}`).emit(
                                            'playerBankrupt',
                                            {
                                                ...bankruptcy,
                                                gameId,
                                                tradeResponderPlayerId:
                                                    respondingPlayerId
                                            }
                                        );
                                    });
                                }
                                sendJson(res, 200, {
                                    message: bankruptcies.length > 0
                                        ? 'Trade accepted. A player went bankrupt after reaching $0.'
                                        : 'Trade offer accepted.',
                                    bankruptcies
                                });
                                return;
                            }

                            const possible = possibleBankruptcies[index];
                            declareBankruptcyAtZero(
                                db,
                                gameId,
                                possible.playerId,
                                possible.creditorId,
                                (bankruptcyErr, bankruptcy) => {
                                    if (bankruptcyErr) {
                                        console.error(
                                            'Trade zero-balance bankruptcy error:',
                                            bankruptcyErr
                                        );
                                        sendJson(res, 500, {
                                            message: 'Trade completed, but bankruptcy could not be processed.'
                                        });
                                        return;
                                    }
                                    if (bankruptcy) bankruptcies.push(bankruptcy);
                                    processTradeBankruptcy(index + 1, bankruptcies);
                                },
                                { preserveTurn: true }
                            );
                        };

                        processTradeBankruptcy(0, []);
                    })().catch(error => {
                        if (error.status) {
                            fail(error.status, error.message);
                            return;
                        }

                        console.error('Respond to trade offer error:', error);
                        fail(
                            500,
                            'Could not respond to the trade offer.'
                        );
                    });
                });
            });
        });

        return true;
    }

    if (req.method !== 'POST' || route !== '/games/trades/create') {
        return false;
    }

    const session = getSession(req);

    if (!session) {
        sendJson(res, 401, {
            message: 'Please log in before creating a trade offer.'
        });
        return true;
    }

    readJsonBody(req, res, requestData => {
        const gameId = Number(requestData.gameId);
        const receivingPlayerId = Number(requestData.receivingPlayerId);
        const localOfferingPlayerId = Number(requestData.offeringPlayerId);
        const offeringCash = Number(requestData.offeringCash || 0);
        const receivingCash = Number(requestData.receivingCash || 0);
        const properties = requestData.properties;

        if (
            !Number.isSafeInteger(gameId) ||
            gameId <= 0 ||
            !Number.isSafeInteger(receivingPlayerId) ||
            receivingPlayerId <= 0 ||
            !Number.isSafeInteger(offeringCash) ||
            offeringCash < 0 ||
            !Number.isSafeInteger(receivingCash) ||
            receivingCash < 0 ||
            !Array.isArray(properties) ||
            properties.length > 28
        ) {
            sendJson(res, 400, { message: 'Invalid trade offer.' });
            return;
        }

        const normalizedProperties = properties.map(property => ({
            propertyId: Number(property.propertyId),
            giverPlayerId: Number(property.giverPlayerId)
        }));
        const propertyIds = normalizedProperties.map(
            property => property.propertyId
        );

        if (
            normalizedProperties.some(
                property =>
                    !Number.isSafeInteger(property.propertyId) ||
                    property.propertyId <= 0 ||
                    !Number.isSafeInteger(property.giverPlayerId) ||
                    property.giverPlayerId <= 0
            ) ||
            new Set(propertyIds).size !== propertyIds.length
        ) {
            sendJson(res, 400, { message: 'Invalid trade property selection.' });
            return;
        }

        db.getConnection((connectionErr, connection) => {
            if (connectionErr) {
                sendJson(res, 500, {
                    message: 'Could not start the trade offer.'
                });
                return;
            }

            connection.beginTransaction(beginErr => {
                if (beginErr) {
                    connection.release();
                    sendJson(res, 500, {
                        message: 'Could not start the trade offer.'
                    });
                    return;
                }

                let transactionFinished = false;

                const failTransaction = (status, message) => {
                    if (transactionFinished) return;
                    transactionFinished = true;
                    connection.rollback(() => {
                        connection.release();
                        sendJson(res, status, { message });
                    });
                };

                const query = (sql, values = []) =>
                    new Promise((resolve, reject) => {
                        connection.query(sql, values, (error, result) => {
                            if (error) {
                                reject(error);
                                return;
                            }

                            resolve(result);
                        });
                    });

                (async () => {
                    const games = await query(
                        `SELECT game_status, game_mode, host_user_id,
                                current_player_id, turn_has_rolled
                         FROM Game
                         WHERE game_id = ?
                         FOR UPDATE`,
                        [gameId]
                    );

                    if (
                        games.length === 0 ||
                        games[0].game_status !== 'in_progress'
                    ) {
                        throw Object.assign(
                            new Error('This game is not in progress.'),
                            { status: 409 }
                        );
                    }

                    const isLocalGame = games[0].game_mode === 'local';
                    if (
                        isLocalGame &&
                        (!Number.isSafeInteger(localOfferingPlayerId) ||
                            localOfferingPlayerId <= 0)
                    ) {
                        throw Object.assign(
                            new Error('Select the active local player to trade.'),
                            { status: 400 }
                        );
                    }

                    const offeringPlayers = isLocalGame
                        ? await query(
                            `SELECT player_id, player_name, money
                             FROM Player
                             WHERE game_id = ?
                               AND player_id = ?
                               AND is_bankrupt = 0
                             FOR UPDATE`,
                            [gameId, localOfferingPlayerId]
                        )
                        : await query(
                            `SELECT player_id, player_name, money
                             FROM Player
                             WHERE game_id = ?
                               AND user_id = ?
                               AND is_bankrupt = 0
                             FOR UPDATE`,
                            [gameId, Number(session.userId)]
                        );

                    if (
                        isLocalGame &&
                        Number(games[0].host_user_id) !== Number(session.userId)
                    ) {
                        throw Object.assign(
                            new Error('You cannot trade in this local game.'),
                            { status: 403 }
                        );
                    }

                    if (offeringPlayers.length === 0) {
                        throw Object.assign(
                            new Error('You are not an active player in this game.'),
                            { status: 403 }
                        );
                    }

                    const offeringPlayer = offeringPlayers[0];

                    if (
                        Number(games[0].current_player_id) !==
                        Number(offeringPlayer.player_id)
                    ) {
                        throw Object.assign(
                            new Error('You can only create a trade on your turn.'),
                            { status: 409 }
                        );
                    }

                    if (Number(games[0].turn_has_rolled) !== 0) {
                        throw Object.assign(
                            new Error('Trade offers must be made before rolling.'),
                            { status: 409 }
                        );
                    }

                    if (
                        Number(offeringPlayer.player_id) ===
                        receivingPlayerId
                    ) {
                        throw Object.assign(
                            new Error('You cannot trade with yourself.'),
                            { status: 400 }
                        );
                    }

                    const receivingPlayers = await query(
                        `SELECT player_id, is_bankrupt
                         FROM Player
                         WHERE player_id = ?
                           AND game_id = ?
                         FOR UPDATE`,
                        [receivingPlayerId, gameId]
                    );

                    if (
                        receivingPlayers.length === 0 ||
                        Number(receivingPlayers[0].is_bankrupt) === 1
                    ) {
                        throw Object.assign(
                            new Error('The selected player is not active in this game.'),
                            { status: 400 }
                        );
                    }

                    const ownedPropertyRows = await query(
                        `SELECT property_id
                         FROM Player_Property
                         WHERE player_id = ?
                         FOR UPDATE`,
                        [offeringPlayer.player_id]
                    );

                    if (ownedPropertyRows.length === 0) {
                        throw Object.assign(
                            new Error('You must own at least one property to trade.'),
                            { status: 409 }
                        );
                    }

                    if (Number(offeringPlayer.money) < offeringCash) {
                        throw Object.assign(
                            new Error('You do not have enough cash for this offer.'),
                            { status: 409 }
                        );
                    }

                    if (normalizedProperties.length > 0) {
                        const propertyRows = await query(
                            `SELECT
                                 pp.property_id,
                                 pp.player_id,
                                 pp.houses,
                                 pp.hotels
                             FROM Player_Property AS pp
                             JOIN Player AS p
                               ON p.player_id = pp.player_id
                             WHERE p.game_id = ?
                               AND p.is_bankrupt = 0
                               AND pp.player_id IN (?, ?)
                             FOR UPDATE`,
                            [
                                gameId,
                                offeringPlayer.player_id,
                                receivingPlayerId
                            ]
                        );

                        for (const property of normalizedProperties) {
                            const ownedProperty = propertyRows.find(
                                row =>
                                    Number(row.property_id) === property.propertyId
                            );

                            if (
                                !ownedProperty ||
                                Number(ownedProperty.player_id) !==
                                    property.giverPlayerId
                            ) {
                                throw Object.assign(
                                    new Error('A selected property is not owned by its listed player.'),
                                    { status: 409 }
                                );
                            }

                            if (
                                Number(ownedProperty.houses) > 0 ||
                                Number(ownedProperty.hotels) > 0
                            ) {
                                throw Object.assign(
                                    new Error('Sell the houses and hotels before trading this property.'),
                                    { status: 409 }
                                );
                            }
                        }
                    }

                    const offerResult = await query(
                        `INSERT INTO Trade_Offer
                            (
                                game_id,
                                offering_player_id,
                                receiving_player_id,
                                offering_cash,
                                receiving_cash,
                                status
                            )
                         VALUES (?, ?, ?, ?, ?, 'pending')`,
                        [
                            gameId,
                            offeringPlayer.player_id,
                            receivingPlayerId,
                            offeringCash,
                            receivingCash
                        ]
                    );

                    for (const property of normalizedProperties) {
                        await query(
                            `INSERT INTO Trade_Offer_Property
                                (
                                    trade_id,
                                    game_id,
                                    property_id,
                                    property_giver_player_id
                                )
                             VALUES (?, ?, ?, ?)`,
                            [
                                offerResult.insertId,
                                gameId,
                                property.propertyId,
                                property.giverPlayerId
                            ]
                        );
                    }

                    await new Promise((resolve, reject) => {
                        connection.commit(error => {
                            if (error) {
                                reject(error);
                                return;
                            }
                            resolve();
                        });
                    });

                    transactionFinished = true;
                    connection.release();

                    if (io) {
                        io.to(`game:${gameId}`).emit('tradeOfferCreated', {
                            gameId,
                            tradeId: offerResult.insertId,
                            offeringPlayerId: Number(offeringPlayer.player_id),
                            receivingPlayerId,
                            offeringCash,
                            receivingCash,
                            properties: normalizedProperties
                        });
                    }

                    sendJson(res, 201, {
                        message: 'Trade offer sent.',
                        tradeId: offerResult.insertId
                    });
                })().catch(error => {
                    if (error.status) {
                        failTransaction(error.status, error.message);
                        return;
                    }

                    console.error('Create trade offer error:', error);
                    failTransaction(500, 'Could not create the trade offer.');
                });
            });
        });
    });

    return true;
}

module.exports = handleGameTradeRequest;

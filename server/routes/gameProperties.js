const {
    purchaseProperty,
    purchaseBuilding
} = require('../Gameplay/properties');

function handleGamePropertyRequest(req, res, { db, getSession, sendJson, readJsonBody, io }) {
    const route = req.url.split('?')[0];

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

    if (req.method === 'POST' && route === '/games/buy-building') {
        const session = getSession(req);

        if (!session) {
            sendJson(res, 401, {
                message: 'Please log in to buy a building.'
            });
            return true;
        }

        readJsonBody(req, res, requestData => {
            const gameId = Number(requestData.gameId);
            const propertyId = Number(requestData.propertyId);
            const buildingType = requestData.buildingType;

            if (
                !Number.isSafeInteger(gameId) ||
                gameId <= 0 ||
                !Number.isSafeInteger(propertyId) ||
                propertyId <= 0 ||
                !['house', 'hotel'].includes(buildingType)
            ) {
                sendJson(res, 400, {
                    message: 'Invalid building purchase request.'
                });
                return;
            }

            purchaseBuilding(
                db,
                session.userId,
                gameId,
                propertyId,
                buildingType,
                (purchaseErr, building) => {
                    if (purchaseErr) {
                        const expectedMessages = new Set([
                            'It is not your turn in an active game.',
                            'Property not found.',
                            'You can only build on color-group properties.',
                            'You must own the full color set before building.',
                            'You cannot build while a property in the set is mortgaged.',
                            'A property can have no more than four houses before a hotel.',
                            'You need four houses on this property before buying a hotel.',
                            'The building cost is not set correctly for this property.',
                            'You do not have enough money to buy this building.',
                            'The building count changed. Refresh the game and try again.'
                        ]);

                        if (!expectedMessages.has(purchaseErr.message)) {
                            console.error('Purchase building error:', purchaseErr);
                            sendJson(res, 500, {
                                message: 'Could not purchase the building.'
                            });
                            return;
                        }

                        sendJson(res, 409, {
                            message: purchaseErr.message
                        });
                        return;
                    }

                    if (io) {
                        io.to(`game:${gameId}`).emit('buildingPurchased', {
                            gameId,
                            ...building
                        });
                    }

                    sendJson(res, 200, {
                        message:
                            `You purchased a ${buildingType} on ` +
                            `${building.propertyName} for $${building.cost}.`,
                        building
                    });
                }
            );
        });

        return true;
    }

    return false;
}

module.exports = handleGamePropertyRequest;

const {
    purchaseProperty,
    purchaseBuilding,
    sellBuilding,
    mortgageProperty,
    unmortgageProperty
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

    if (req.method === 'POST' && route === '/games/sell-building') {
    const session = getSession(req);

    if (!session) {
        sendJson(res, 401, {
            message: 'Please log in to sell a building.'
        });
        return true;
    }

    readJsonBody(req, res, requestData => {
        const gameId = Number(requestData.gameId);
        const propertyId = Number(requestData.propertyId);

        if (
            !Number.isSafeInteger(gameId) ||
            gameId <= 0 ||
            !Number.isSafeInteger(propertyId) ||
            propertyId <= 0
        ) {
            sendJson(res, 400, {
                message: 'Invalid building sale request.'
            });
            return;
        }

        sellBuilding(
            db,
            session.userId,
            gameId,
            propertyId,
            (saleErr, building) => {
                if (saleErr) {
                    const expectedMessages = new Set([
                        'It is not your turn in an active game.',
                        'You do not own this property.',
                        'You must own the full color set to sell buildings.',
                        'Sell buildings evenly across the color set.',
                        'This property has no buildings to sell.',
                        'Could not sell this building.',
                        'Could not add the sale money to your balance.'
                    ]);

                    if (!expectedMessages.has(saleErr.message)) {
                        console.error('Sell building error:', saleErr);
                        sendJson(res, 500, {
                            message: 'Could not sell the building.'
                        });
                        return;
                    }

                    sendJson(res, 409, {
                        message: saleErr.message
                    });
                    return;
                }

                if (io) {
                    io.to(`game:${gameId}`).emit('buildingSold', {
                        gameId,
                        ...building
                    });
                }

                sendJson(res, 200, {
                    message:
                        `You sold a ${building.buildingType} on ` +
                        `${building.propertyName} for $${building.saleValue}.`,
                    building
                });
            }
        );
    });

    return true;
}

    if (req.method === 'POST' && route === '/games/mortgage-property') {
        const session = getSession(req);

        if (!session) {
            sendJson(res, 401, {
                message: 'Please log in to mortgage a property.'
            });
            return true;
        }

        readJsonBody(req, res, requestData => {
            const gameId = Number(requestData.gameId);
            const propertyId = Number(requestData.propertyId);

            if (
                !Number.isSafeInteger(gameId) ||
                gameId <= 0 ||
                !Number.isSafeInteger(propertyId) ||
                propertyId <= 0
            ) {
                sendJson(res, 400, {
                    message: 'Invalid mortgage request.'
                });
                return;
            }

            mortgageProperty(
                db,
                session.userId,
                gameId,
                propertyId,
                (mortgageErr, mortgage) => {
                    if (mortgageErr) {
                        const expectedMessages = new Set([
                            'It is not your turn in an active game.',
                            'You are not an active player in this game.',
                            'Property not found.',
                            'You do not own this property.',
                            'This property is already mortgaged.',
                            'Sell all houses and hotels in this color set before mortgaging.',
                            'The mortgage value is not set correctly.',
                            'The property mortgage status changed. Refresh and try again.',
                            'Could not add the mortgage money to your balance.'
                        ]);

                        if (!expectedMessages.has(mortgageErr.message)) {
                            console.error('Mortgage property error:', mortgageErr);
                            sendJson(res, 500, {
                                message: 'Could not mortgage the property.'
                            });
                            return;
                        }

                        const status =
                            mortgageErr.message ===
                                'You are not an active player in this game.'
                                ? 403
                                : 409;

                        sendJson(res, status, {
                            message: mortgageErr.message
                        });
                        return;
                    }

                    if (io) {
                        io.to(`game:${gameId}`).emit('propertyMortgaged', {
                            gameId,
                            ...mortgage
                        });
                    }

                    sendJson(res, 200, {
                        message:
                            `You mortgaged ${mortgage.propertyName} ` +
                            `for $${mortgage.mortgageValue}.`,
                        mortgage
                    });
                }
            );
        });

        return true;
    }

    if (req.method === 'POST' && route === '/games/unmortgage-property') {
        const session = getSession(req);

        if (!session) {
            sendJson(res, 401, {
                message: 'Please log in to unmortgage a property.'
            });
            return true;
        }

        readJsonBody(req, res, requestData => {
            const gameId = Number(requestData.gameId);
            const propertyId = Number(requestData.propertyId);

            if (
                !Number.isSafeInteger(gameId) ||
                gameId <= 0 ||
                !Number.isSafeInteger(propertyId) ||
                propertyId <= 0
            ) {
                sendJson(res, 400, {
                    message: 'Invalid unmortgage request.'
                });
                return;
            }

            unmortgageProperty(
                db,
                session.userId,
                gameId,
                propertyId,
                (unmortgageErr, result) => {
                    if (unmortgageErr) {
                        const expectedMessages = new Set([
                            'It is not your turn in an active game.',
                            'You are not an active player in this game.',
                            'You do not own this property.',
                            'This property is not mortgaged.',
                            'The mortgage value is not set correctly.',
                            'You do not have enough money to lift this mortgage.',
                            'The property mortgage status changed. Refresh and try again.'
                        ]);

                        if (!expectedMessages.has(unmortgageErr.message)) {
                            console.error('Unmortgage property error:', unmortgageErr);
                            sendJson(res, 500, {
                                message: 'Could not unmortgage the property.'
                            });
                            return;
                        }

                        const status =
                            unmortgageErr.message ===
                                'You are not an active player in this game.'
                                ? 403
                                : 409;

                        sendJson(res, status, {
                            message: unmortgageErr.message
                        });
                        return;
                    }

                    if (io) {
                        io.to(`game:${gameId}`).emit('propertyUnmortgaged', {
                            gameId,
                            ...result
                        });
                    }

                    sendJson(res, 200, {
                        message:
                            `You unmortgaged ${result.propertyName} ` +
                            `for $${result.repaymentAmount}.`,
                        unmortgage: result
                    });
                }
            );
        });

        return true;
    }

    return false;
}

module.exports = handleGamePropertyRequest;

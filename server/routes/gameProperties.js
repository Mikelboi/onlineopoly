const { purchaseProperty } = require('../Gameplay/properties');

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

    return false;
}

module.exports = handleGamePropertyRequest;

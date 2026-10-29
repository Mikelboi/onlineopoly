const {
    rollDice,
    calculateNewPosition
} = require('../Gameplay/movement');

const { updatePlayerMoney } = require('../Gameplay/money');
const { payRent } = require('../Gameplay/properties');

function handleGameMovementRequest(req, res, { db, getSession, sendJson, readJsonBody, io }) {
    const route = req.url.split('?')[0];

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

    return false;
}

module.exports = handleGameMovementRequest;

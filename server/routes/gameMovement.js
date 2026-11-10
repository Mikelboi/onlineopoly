const {
    rollDice,
    calculateNewPosition
} = require('../Gameplay/movement');

const { updatePlayerMoney } = require('../Gameplay/money');
const { payRent } = require('../Gameplay/properties');
const chanceCards = require('../Gameplay/chance');

const {
    applyPlayerTransferCard
} = require('../Gameplay/chanceTransfers');

function handleGameMovementRequest(req, res, { db, getSession, sendJson, readJsonBody, io }) {
    const route = req.url.split('?')[0];

    if (req.method === 'POST' && route === '/games/use-jail-card') {
        const session = getSession(req);

        if (!session) {
            sendJson(res, 401, {
                message: 'Please log in before using a Jail card.'
            });
            return true;
        }

        readJsonBody(req, res, requestData => {
            const gameId = Number(requestData.gameId);

            if (!Number.isSafeInteger(gameId) || gameId <= 0) {
                sendJson(res, 400, { message: 'Invalid game ID.' });
                return;
            }

            db.query(
                `SELECT game_status, current_player_id
                 FROM Game
                 WHERE game_id = ?`,
                [gameId],
                (gameErr, games) => {
                    if (gameErr) {
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
                        `SELECT player_id, is_in_jail, jail_free_cards
                         FROM Player
                         WHERE game_id = ? AND user_id = ? AND is_bankrupt = 0`,
                        [gameId, session.userId],
                        (playerErr, players) => {
                            if (playerErr || players.length === 0) {
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

                            db.query(
                                `UPDATE Player
                                 SET is_in_jail = 0,
                                     jail_turns = 0,
                                     jail_free_cards = jail_free_cards - 1
                                 WHERE player_id = ?
                                   AND game_id = ?
                                   AND is_in_jail = 1
                                   AND jail_free_cards > 0
                                   AND is_bankrupt = 0`,
                                [player.player_id, gameId],
                                (updateErr, result) => {
                                    if (updateErr || result.affectedRows !== 1) {
                                        sendJson(res, 409, {
                                            message: 'You cannot use a Jail card right now.'
                                        });
                                        return;
                                    }

                                    sendJson(res, 200, {
                                        message: 'Jail card used. You are free to roll.'
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
                        `SELECT player_id, player_name, position,is_in_jail, jail_free_cards,jail_turns
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
                            let chanceCard = null;
                            let passedGo = false;
                            let sendToJail = false;
                            let releaseFromJail = false;
                            let jailBailRequired = false;

                            try {
                                dice = rollDice();
                                if (Number(player.is_in_jail) === 1) {
                                    if (dice.die1 === dice.die2) {
                                        releaseFromJail = true;
                                    } else {
                                        const currentJailTurns = Number(
                                            player.jail_turns
                                        );

                                        if (currentJailTurns >= 2) {
                                            releaseFromJail = true;
                                            jailBailRequired = true;
                                        } else {
                                            db.query(
                                                `UPDATE Player
                                                 SET jail_turns = jail_turns + 1
                                                 WHERE player_id = ?
                                                   AND game_id = ?
                                                   AND is_in_jail = 1
                                                   AND is_bankrupt = 0`,
                                                [player.player_id, gameId],
                                                (jailErr, result) => {
                                                    if (
                                                        jailErr ||
                                                        result.affectedRows !== 1
                                                    ) {
                                                        console.error(
                                                            'Update Jail turn error:',
                                                            jailErr
                                                        );
                                                        sendJson(res, 500, {
                                                            message:
                                                                'Could not update your Jail turn.'
                                                        });
                                                        return;
                                                    }

                                                    sendJson(res, 200, {
                                                        message:
                                                            'You did not roll doubles and must stay in Jail.',
                                                        dice,
                                                        oldPosition: Number(
                                                            player.position
                                                        ),
                                                        newPosition: Number(
                                                            player.position
                                                        ),
                                                        passedGo: false,
                                                        jailAttempt:
                                                            currentJailTurns + 1
                                                    });
                                                }
                                            );

                                            return;
                                        }
                                    }
                                }
                                newPosition = calculateNewPosition(
                                    Number(player.position),
                                    dice.total
                                );
                                const landedOnGoToJail = newPosition === 30;
                                const chanceCardPositions = [7, 22, 36];
                                chanceCard = chanceCardPositions.includes(newPosition)
                                    ? chanceCards[Math.floor(Math.random() * chanceCards.length)]
                                    : null;
                                passedGo =
                                    Number(player.position) + dice.total >= 40;

                                if (
                                    chanceCard &&
                                    chanceCard.type === 'move_to'
                                ) {
                                    newPosition = chanceCard.position;

                                    if (chanceCard.collectGo) {
                                        passedGo = true;
                                    }
                                } else if (
                                    chanceCard &&
                                    chanceCard.type === 'move_relative'
                                ) {
                                    newPosition =
                                        (newPosition + chanceCard.spaces + 40) %
                                        40;
                                } else if (
                                    chanceCard &&
                                    chanceCard.type === 'move_to_nearest'
                                ) {
                                    const destinationPositions = {
                                        railroad: [5, 15, 25, 35],
                                        utility: [12, 28]
                                    };


                                    const targets =
                                        destinationPositions[chanceCard.target];

                                    if (!targets) {
                                        throw new Error(
                                            'Invalid nearest-space Chance card target.'
                                        );
                                    }

                                    newPosition =
                                        targets.find(
                                            position => position > newPosition
                                        ) ?? targets[0];
                                } else if (
                                    chanceCard &&
                                    chanceCard.type === 'go_to_jail'
                                ) {
                                    newPosition = 10;
                                    sendToJail = true;
                                }

                                if (landedOnGoToJail) {
                                    newPosition = 10;
                                    sendToJail = true;
                                }
                            } catch (error) {
                                console.error('Dice roll error:', error);
                                sendJson(res, 500, {
                                    message: 'Could not roll the dice.'
                                });
                                return;
                            }

                            const updatePlayerPosition = () => db.query(
                                `UPDATE Player
                                 SET position = ?,
                                     is_in_jail = CASE
                                         WHEN ? = 1 THEN 1
                                         WHEN ? = 1 THEN 0
                                         ELSE is_in_jail
                                     END,
                                     jail_turns = CASE
                                         WHEN ? = 1 OR ? = 1 THEN 0
                                         ELSE jail_turns
                                     END
                                 WHERE player_id = ? AND game_id = ?`,
                                [
                                    newPosition,
                                    sendToJail ? 1 : 0,
                                    releaseFromJail ? 1 : 0,
                                    sendToJail ? 1 : 0,
                                    releaseFromJail ? 1 : 0,
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

                                    console.log('GO reward check:', {
                                        oldPosition,
                                        newPosition,
                                        passedGo,
                                        playerId: player.player_id
                                    });

                                    const finishRoll = () => {
                                        payRent(
                                            db,
                                            Number(session.userId),
                                            Number(gameId),
                                            (rentErr, rentResult) => {
                                                if (rentErr) {
                                                    console.error(
                                                        'Rent payment error:',
                                                        rentErr
                                                    );

                                                    if (io) {
                                                        io.to(`game:${gameId}`).emit(
                                                            'playerMoved',
                                                            {
                                                                gameId,
                                                                playerId: player.player_id,
                                                                playerName: player.player_name,
                                                                oldPosition,
                                                                newPosition,
                                                                dice,
                                                                diceTotal: dice.total
                                                            }
                                                        );
                                                    }

                                                    sendJson(res, 500, {
                                                        message:
                                                            'Movement succeeded, but rent processing failed.',
                                                        dice,
                                                        oldPosition,
                                                        newPosition,
                                                        passedGo
                                                    });
                                                    return;
                                                }

                                                if (io) {
                                                    io.to(`game:${gameId}`).emit(
                                                        'playerMoved',
                                                        {
                                                            gameId,
                                                            playerId: player.player_id,
                                                            playerName: player.player_name,
                                                            oldPosition,
                                                            newPosition,
                                                            dice,
                                                            diceTotal: dice.total
                                                        }
                                                    );
                                                }

                                                if (
                                                    io &&
                                                    rentResult &&
                                                    rentResult.rentPaid
                                                ) {
                                                    io.to(`game:${gameId}`).emit(
                                                        'rentPaid',
                                                        {
                                                            gameId,
                                                            playerId: player.player_id,
                                                            playerName: player.player_name,
                                                            propertyName:
                                                                rentResult.propertyName,
                                                            rent: rentResult.rent,
                                                            ownerPlayerName:
                                                                rentResult.ownerPlayerName
                                                        }
                                                    );
                                                }

                                                sendJson(res, 200, {
                                                    message:
                                                        rentResult && rentResult.rentPaid
                                                            ? `You paid $${rentResult.rent} rent for ${rentResult.propertyName}.`
                                                            : sendToJail
                                                                ? 'You landed on Go To Jail and were sent to Jail.'
                                                            : jailBailRequired
                                                                ? 'You paid $50 bail and left Jail.'
                                                                : passedGo
                                                                    ? 'You passed GO and collected $200.'
                                                                    : '',
                                                    dice,
                                                    oldPosition,
                                                    newPosition,
                                                    passedGo,
                                                    sentToJail: sendToJail,
                                                    chanceCard,
                                                    jailBailPaid: jailBailRequired,
                                                    rent: rentResult
                                                });
                                            },
                                            {
                                                chanceCard:
                                                    chanceCard &&
                                                    chanceCard.type ===
                                                        'move_to_nearest'
                                                        ? chanceCard
                                                        : null,
                                                diceTotal: dice.total
                                            }
                                        );
                                    };

                                    const finishRollAfterChanceCard = () => {
                                        if (!chanceCard) {
                                            finishRoll();
                                            return;
                                        }

                                        if (
                                            chanceCard.type ===
                                            'get_out_of_jail_free'
                                        ) {
                                            db.query(
                                                `UPDATE Player
                                                 SET jail_free_cards = jail_free_cards + 1
                                                 WHERE player_id = ?
                                                   AND game_id = ?
                                                   AND is_bankrupt = 0`,
                                                [player.player_id, gameId],
                                                (cardErr, result) => {
                                                    if (
                                                        cardErr ||
                                                        result.affectedRows !== 1
                                                    ) {
                                                        console.error(
                                                            'Save Get Out of Jail Free card error:',
                                                            cardErr
                                                        );
                                                        sendJson(res, 500, {
                                                            message:
                                                                'The Get Out of Jail Free card could not be saved.'
                                                        });
                                                        return;
                                                    }

                                                    finishRoll();
                                                }
                                            );

                                            return;
                                        }

                                        if (
                                            chanceCard.type === 'pay_each_player' ||
                                            chanceCard.type === 'collect_each_player'
                                        ) {
                                            applyPlayerTransferCard(
                                                db,
                                                Number(gameId),
                                                Number(player.player_id),
                                                chanceCard,
                                                transferErr => {
                                                    if (transferErr) {
                                                        console.error(
                                                            'Chance player transfer error:',
                                                            transferErr
                                                        );
                                                        sendJson(res, 500, {
                                                            message:
                                                                'Movement succeeded, but the Chance card transfer could not be completed.'
                                                        });
                                                        return;
                                                    }

                                                    finishRoll();
                                                }
                                            );

                                            return;
                                        }

                                        if (chanceCard.type === 'pay_repairs') {
                                            db.query(
                                                `SELECT
                                                     COALESCE(SUM(houses), 0) AS houseCount,
                                                     COALESCE(SUM(hotels), 0) AS hotelCount
                                                 FROM Player_Property
                                                 WHERE player_id = ?`,
                                                [player.player_id],
                                                (repairErr, repairRows) => {
                                                    if (repairErr) {
                                                        console.error(
                                                            'Chance repairs lookup error:',
                                                            repairErr
                                                        );
                                                        sendJson(res, 500, {
                                                            message:
                                                                'Movement succeeded, but repair costs could not be calculated.'
                                                        });
                                                        return;
                                                    }

                                                    const repairCost =
                                                        Number(repairRows[0].houseCount) *
                                                            chanceCard.houseCost +
                                                        Number(repairRows[0].hotelCount) *
                                                            chanceCard.hotelCost;

                                                    if (repairCost === 0) {
                                                        finishRoll();
                                                        return;
                                                    }

                                                    updatePlayerMoney(
                                                        db,
                                                        Number(player.player_id),
                                                        Number(gameId),
                                                        -repairCost,
                                                        'Chance Repairs',
                                                        repairMoneyErr => {
                                                            if (repairMoneyErr) {
                                                                console.error(
                                                                    'Chance repairs payment error:',
                                                                    repairMoneyErr
                                                                );
                                                                sendJson(res, 500, {
                                                                    message:
                                                                        'Movement succeeded, but the repair costs could not be paid.'
                                                                });
                                                                return;
                                                            }

                                                            finishRoll();
                                                        }
                                                    );
                                                }
                                            );
                                            return;
                                        }

                                        if (
                                            chanceCard.type !== 'collect' &&
                                            chanceCard.type !== 'pay'
                                        ) {
                                            finishRoll();
                                            return;
                                        }

                                        const amount = chanceCard.type === 'collect'
                                            ? chanceCard.amount
                                            : -chanceCard.amount;

                                        updatePlayerMoney(
                                            db,
                                            Number(player.player_id),
                                            Number(gameId),
                                            amount,
                                            'Chance Card',
                                            chanceErr => {
                                                if (chanceErr) {
                                                    console.error(
                                                        'Chance card money update error:',
                                                        chanceErr
                                                    );
                                                    sendJson(res, 500, {
                                                        message:
                                                            'Movement succeeded, but the Chance card could not be applied.'
                                                    });
                                                    return;
                                                }

                                                finishRoll();
                                            }
                                        );
                                    };

                                    if (passedGo) {
                                        updatePlayerMoney(
                                            db,
                                            Number(player.player_id),
                                            Number(gameId),
                                            200,
                                            'GO Reward',
                                            moneyErr => {
                                                if (moneyErr) {
                                                    console.error(
                                                        'GO reward error:',
                                                        moneyErr
                                                    );
                                                    sendJson(res, 500, {
                                                        message:
                                                            'Movement succeeded, but the GO reward failed.'
                                                    });
                                                    return;
                                                }

                                                finishRollAfterChanceCard();
                                            }
                                        );
                                    } else {
                                        finishRollAfterChanceCard();
                                    }
                                }
                            );

                            if (jailBailRequired) {
                                updatePlayerMoney(
                                    db,
                                    Number(player.player_id),
                                    Number(gameId),
                                    -50,
                                    'Jail Bail',
                                    bailErr => {
                                        if (bailErr) {
                                            console.error(
                                                'Jail bail payment error:',
                                                bailErr
                                            );
                                            sendJson(res, 500, {
                                                message:
                                                    'You must pay $50 to leave Jail, but the payment could not be completed.'
                                            });
                                            return;
                                        }

                                        updatePlayerPosition();
                                    }
                                );
                            } else {
                                updatePlayerPosition();
                            }
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

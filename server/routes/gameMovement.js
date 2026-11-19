const {
    rollDice,
    calculateNewPosition
} = require('../Gameplay/movement');

const { updatePlayerMoney } = require('../Gameplay/money');
const { payRent } = require('../Gameplay/properties');
const {
    declareBankruptcy,
    recordPendingDebt,
    settlePendingDebt
} = require('../Gameplay/bankrupt');
const chanceCards = require('../Gameplay/chance');
const communityChestCards = require('../Gameplay/communityChest');

const {
    applyPlayerTransferCard
} = require('../Gameplay/chanceTransfers');

// Test roll sequence for the first player in each game. These legal rolls
// land on the two properties in the first color set: positions 3, then 1.
const playerOneTestRolls = [
    { die1: 1, die2: 2 }, // Position 3
    { die1: 3, die2: 5 }, // Position 11
    { die1: 4, die2: 6 }, // Position 21
    { die1: 4, die2: 6 }, // Position 31
    { die1: 4, die2: 6 }  // Position 1, passing GO
];
const playerOneTestRollCounts = new Map();
const playerOneTaxTestProgress = new Map();
const playerTwoRentTestLandings = new Set();
const playerTwoTestPropertyNames = {
    1: 'Dragon Drive',
    3: 'Circus Circle'
};

function rollForPlayer(gameId, player) {
    if (Number(player.player_id) !== Number(player.first_player_id)) {
        return rollDice();
    }

    const rollKey = `${gameId}:${player.player_id}`;
    const rollIndex = playerOneTestRollCounts.get(rollKey) || 0;

    if (rollIndex >= playerOneTestRolls.length) {
        return rollDice();
    }

    playerOneTestRollCounts.set(rollKey, rollIndex + 1);
    return {
        ...playerOneTestRolls[rollIndex],
        total:
            playerOneTestRolls[rollIndex].die1 +
            playerOneTestRolls[rollIndex].die2
    };
}

function sendPendingDebtResponse(
    db,
    res,
    sendJson,
    gameId,
    debtorPlayerId,
    creditorPlayerId,
    amountDue,
    debtSource,
    responseData = {}
) {
    recordPendingDebt(
        db,
        gameId,
        debtorPlayerId,
        creditorPlayerId,
        amountDue,
        debtSource,
        (debtErr, debtResult) => {
            sendJson(res, debtErr ? 500 : 409, {
                ...responseData,
                message: debtErr
                    ? debtErr.message
                    : 'Payment is pending. Sell buildings or mortgage properties, then retry the payment.',
                ...(debtErr
                    ? {}
                    : { pendingDebtId: debtResult.insertId })
            });
        }
    );
}

function recordPendingDebtsForPlayers(
    db,
    gameId,
    debtorPlayerId,
    amountPerPlayer,
    debtSource,
    callback
) {
    db.query(
        `SELECT player_id
         FROM Player
         WHERE game_id = ?
           AND player_id <> ?
           AND is_bankrupt = 0`,
        [gameId, debtorPlayerId],
        (playersErr, players) => {
            if (playersErr) {
                callback(playersErr);
                return;
            }

            const pendingDebtIds = [];
            let playerIndex = 0;

            const recordNextDebt = () => {
                if (playerIndex >= players.length) {
                    callback(null, pendingDebtIds);
                    return;
                }

                const creditorPlayerId = Number(
                    players[playerIndex].player_id
                );
                playerIndex += 1;

                recordPendingDebt(
                    db,
                    gameId,
                    debtorPlayerId,
                    creditorPlayerId,
                    amountPerPlayer,
                    debtSource,
                    (debtErr, debtResult) => {
                        if (debtErr) {
                            callback(debtErr);
                            return;
                        }

                        pendingDebtIds.push(debtResult.insertId);
                        recordNextDebt();
                    }
                );
            };

            recordNextDebt();
        }
    );
}

function handleGameMovementRequest(req, res, { db, getSession, sendJson, readJsonBody, io }) {
    const route = req.url.split('?')[0];

    if (req.method === 'POST' && route === '/games/pay-pending-debt') {
        const session = getSession(req);

        if (!session) {
            sendJson(res, 401, {
                message: 'Please log in before paying a pending debt.'
            });
            return true;
        }

        readJsonBody(req, res, requestData => {
            const gameId = Number(requestData.gameId);
            const pendingDebtId = Number(requestData.pendingDebtId);

            if (
                !Number.isSafeInteger(gameId) ||
                gameId <= 0 ||
                !Number.isSafeInteger(pendingDebtId) ||
                pendingDebtId <= 0
            ) {
                sendJson(res, 400, {
                    message: 'Invalid pending debt payment request.'
                });
                return;
            }

            settlePendingDebt(
                db,
                gameId,
                pendingDebtId,
                Number(session.userId),
                (paymentErr, payment) => {
                    if (paymentErr) {
                        const conflictMessages = new Set([
                            'You can only retry this debt during your turn.',
                            'The debtor is bankrupt.',
                            'You still do not have enough money to pay this debt.',
                            'The creditor is no longer active.',
                            'The payment could not be taken from your balance.',
                            'Could not clear the paid debt.'
                        ]);
                        const status =
                            paymentErr.message === 'Pending debt not found.'
                                ? 404
                                : paymentErr.message.startsWith('Invalid')
                                    ? 400
                                    : paymentErr.message.startsWith('You cannot')
                                        ? 403
                                        : conflictMessages.has(paymentErr.message)
                                            ? 409
                                            : 500;
                        sendJson(res, status, {
                            message: paymentErr.message
                        });
                        return;
                    }

                    if (io) {
                        io.to(`game:${gameId}`).emit('pendingDebtPaid', {
                            gameId,
                            ...payment
                        });
                    }

                    sendJson(res, 200, {
                        message:
                            `Paid $${payment.amountDue} for ${payment.debtSource}.`,
                        payment
                    });
                }
            );
        });

        return true;
    }

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
                        `SELECT player_id, player_name, position, is_in_jail,
                                jail_free_cards, jail_turns, consecutive_doubles,
                                (SELECT MIN(player_id)
                                 FROM Player
                                 WHERE game_id = ?) AS first_player_id,
                                (SELECT player_id
                                  FROM Player
                                  WHERE game_id = ?
                                  ORDER BY player_id ASC
                                  LIMIT 1 OFFSET 1) AS second_player_id,
                                (
                                    SELECT test_property.board_position
                                    FROM Player_Property AS test_ownership
                                    JOIN Property AS test_property
                                      ON test_property.property_id =
                                         test_ownership.property_id
                                    WHERE test_ownership.player_id = (
                                        SELECT MIN(player_id)
                                        FROM Player
                                        WHERE game_id = ?
                                    )
                                      AND test_property.board_position IN (1, 3)
                                      AND (
                                          test_ownership.houses > 0
                                          OR test_ownership.hotels > 0
                                      )
                                    ORDER BY test_ownership.hotels DESC,
                                             test_ownership.houses DESC,
                                             test_property.board_position ASC
                                    LIMIT 1
                                ) AS test_target_position,
                                (
                                    SELECT COUNT(*)
                                    FROM Pending_Debt AS debt
                                    WHERE debt.game_id = Player.game_id
                                      AND debt.debtor_player_id = Player.player_id
                                ) AS pending_debt_count
                         FROM Player
                         WHERE game_id = ? AND user_id = ?`,
                        [gameId, gameId, gameId, gameId, session.userId],
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

                            if (Number(player.pending_debt_count) > 0) {
                                sendJson(res, 409, {
                                    message:
                                        'Pay or resolve your pending debts before rolling again.'
                                });
                                return;
                            }

                            let dice;
                            let newPosition;
                            let chanceCard = null;
                            let cardDeckName = null;
                            let passedGo = false;
                            let sendToJail = false;
                            let releaseFromJail = false;
                            let jailBailRequired = false;

                            const wasInJail = Number(player.is_in_jail) === 1;
                            const playerTwoTestKey =
                                `${gameId}:${player.player_id}`;
                            const playerOneTaxTestKey =
                                `${gameId}:${player.player_id}`;
                            const playerOneTaxTestIndex =
                                playerOneTaxTestProgress.get(playerOneTaxTestKey) || 0;
                            const playerOneRollCount =
                                playerOneTestRollCounts.get(playerOneTaxTestKey) || 0;
                            const forceTaxTestLanding =
                                Number(player.player_id) ===
                                    Number(player.first_player_id) &&
                                playerOneRollCount >= playerOneTestRolls.length &&
                                playerOneTaxTestIndex < 2;
                            const taxTestTargetPosition =
                                [4, 38][playerOneTaxTestIndex];
                            const testTargetPosition =
                                player.test_target_position === null ||
                                player.test_target_position === undefined
                                    ? null
                                    : Number(player.test_target_position);
                            const forceRentTestLanding =
                                !wasInJail &&
                                Number(player.player_id) ===
                                    Number(player.second_player_id) &&
                                testTargetPosition !== null &&
                                !playerTwoRentTestLandings.has(playerTwoTestKey);
                            const testPropertyName = forceRentTestLanding
                                ? playerTwoTestPropertyNames[testTargetPosition]
                                : null;
                            let testRentLanding = false;
                            let rolledDoubles = false;
                            let consecutiveDoubles = 0;
                            let thirdConsecutiveDouble = false;

                            try {
                                dice = forceRentTestLanding
                                    ? { die1: 1, die2: 2, total: 3 }
                                    : forceTaxTestLanding
                                        ? { die1: 1, die2: 2, total: 3 }
                                        : rollForPlayer(gameId, player);
                                const isDoubles = dice.die1 === dice.die2;

                                if (!wasInJail && isDoubles) {
                                    consecutiveDoubles =
                                        Number(player.consecutive_doubles) + 1;
                                    thirdConsecutiveDouble = consecutiveDoubles >= 3;
                                    rolledDoubles = !thirdConsecutiveDouble;
                                }

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
                                if (forceRentTestLanding) {
                                    newPosition = testTargetPosition;
                                    testRentLanding = true;
                                } else if (forceTaxTestLanding) {
                                    newPosition = taxTestTargetPosition;
                                }
                                const landedOnGoToJail = newPosition === 30;
                                const chanceCardPositions = [7, 22, 36];
                                const communityChestPositions = [2, 17, 33];

                                if (chanceCardPositions.includes(newPosition)) {
                                    cardDeckName = 'Chance';
                                    chanceCard = {
                                        ...chanceCards[
                                            Math.floor(Math.random() * chanceCards.length)
                                        ],
                                        deckName: cardDeckName
                                    };
                                } else if (
                                    communityChestPositions.includes(newPosition)
                                ) {
                                    cardDeckName = 'Community Chest';
                                    chanceCard = {
                                        ...communityChestCards[
                                            Math.floor(
                                                Math.random() * communityChestCards.length
                                            )
                                        ],
                                        deckName: cardDeckName
                                    };
                                }
                                passedGo = !testRentLanding &&
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
                                            `Invalid nearest-space ${cardDeckName} card target.`
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

                                if (thirdConsecutiveDouble) {
                                    newPosition = 10;
                                    passedGo = false;
                                    sendToJail = true;
                                    chanceCard = null;
                                    cardDeckName = null;
                                    consecutiveDoubles = 0;
                                }

                                if (sendToJail) {
                                    rolledDoubles = false;
                                    consecutiveDoubles = 0;
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
                                     consecutive_doubles = ?,
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
                                    consecutiveDoubles,
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

                                    if (testRentLanding) {
                                        playerTwoRentTestLandings.add(
                                            playerTwoTestKey
                                        );
                                    }

                                    if (forceTaxTestLanding) {
                                        playerOneTaxTestProgress.set(
                                            playerOneTaxTestKey,
                                            playerOneTaxTestIndex + 1
                                        );
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
                                                    if (
                                                        rentErr.message ===
                                                            'You do not have enough money to pay rent.' &&
                                                        Number.isSafeInteger(
                                                            rentErr.amountOwed
                                                        ) &&
                                                        Number.isSafeInteger(
                                                            rentErr.creditorPlayerId
                                                        )
                                                    ) {
                                                        if (io) {
                                                            io.to(`game:${gameId}`).emit(
                                                                'playerMoved',
                                                                {
                                                                    gameId,
                                                                    playerId:
                                                                        player.player_id,
                                                                    playerName:
                                                                        player.player_name,
                                                                    oldPosition,
                                                                    newPosition,
                                                                    dice,
                                                                    diceTotal:
                                                                        dice.total,
                                                                    testRentLanding,
                                                                    testPropertyName
                                                                }
                                                            );
                                                        }

                                                        declareBankruptcy(
                                                            db,
                                                            Number(gameId),
                                                            Number(player.player_id),
                                                            rentErr.creditorPlayerId,
                                                            rentErr.amountOwed,
                                                            (
                                                                bankruptcyErr,
                                                                bankruptcy
                                                            ) => {
                                                                if (bankruptcyErr) {
                                                                    if (
                                                                        bankruptcyErr.message ===
                                                                        'The player can cover this debt by liquidating assets.'
                                                                    ) {
                                                                        recordPendingDebt(
                                                                            db,
                                                                            Number(gameId),
                                                                            Number(player.player_id),
                                                                            rentErr.creditorPlayerId,
                                                                            rentErr.amountOwed,
                                                                            'rent',
                                                                            (debtErr, debtResult) => {
                                                                                if (debtErr) {
                                                                                    sendJson(
                                                                                        res,
                                                                                        500,
                                                                                        {
                                                                                            message: debtErr.message,
                                                                                            dice,
                                                                                            oldPosition,
                                                                                            newPosition,
                                                                                            passedGo
                                                                                        }
                                                                                    );
                                                                                    return;
                                                                                }

                                                                                sendJson(
                                                                                    res,
                                                                                    409,
                                                                                    {
                                                                                        message: 'You owe rent. Sell buildings or mortgage properties, then retry the payment.',
                                                                                        pendingDebtId: debtResult.insertId,
                                                                                        dice,
                                                                                        oldPosition,
                                                                                        newPosition,
                                                                                        passedGo
                                                                                    }
                                                                                );
                                                                            }
                                                                        );
                                                                        return;
                                                                    }

                                                                    sendJson(
                                                                        res,
                                                                        500,
                                                                        {
                                                                            message:
                                                                                bankruptcyErr.message,
                                                                            dice,
                                                                            oldPosition,
                                                                            newPosition,
                                                                            passedGo
                                                                        }
                                                                    );
                                                                    return;
                                                                }

                                                                if (io) {
                                                                    io.to(`game:${gameId}`).emit(
                                                                        'playerBankrupt',
                                                                        {
                                                                            gameId,
                                                                            ...bankruptcy
                                                                        }
                                                                    );
                                                                }

                                                                sendJson(res, 200, {
                                                                    message:
                                                                        `${bankruptcy.playerName} went bankrupt owing ` +
                                                                        `$${bankruptcy.unpaidDebt}.`,
                                                                    dice,
                                                                    oldPosition,
                                                                    newPosition,
                                                                    passedGo,
                                                                    bankruptcy
                                                                });
                                                            }
                                                        );
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
                                                                diceTotal: dice.total,
                                                                testRentLanding,
                                                                testPropertyName
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
                                                            diceTotal: dice.total,
                                                            testRentLanding,
                                                            testPropertyName
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

                                                const sendRollSuccess = taxPayment => {
                                                    let message = '';

                                                    if (taxPayment) {
                                                        message =
                                                            taxPayment.taxName === 'Income Tax'
                                                                ? `You paid $${taxPayment.amount} in income tax.`
                                                                : `You paid a $${taxPayment.amount} luxury tax.`;
                                                    } else if (
                                                        rentResult &&
                                                        rentResult.rentPaid
                                                    ) {
                                                        message =
                                                            `You paid $${rentResult.rent} ` +
                                                            `rent for ${rentResult.propertyName}.`;
                                                    } else if (sendToJail) {
                                                        message = thirdConsecutiveDouble
                                                            ? 'You rolled doubles three times in a row and were sent to Jail.'
                                                            : 'You landed on Go To Jail and were sent to Jail.';
                                                    } else if (jailBailRequired) {
                                                        message =
                                                            'You paid $50 bail and left Jail.';
                                                    } else if (passedGo) {
                                                        message =
                                                            'You passed GO and collected $200.';
                                                    }

                                                    sendJson(res, 200, {
                                                        message,
                                                        dice,
                                                        rolledDoubles,
                                                        oldPosition,
                                                        newPosition,
                                                        passedGo,
                                                        testRentLanding,
                                                        testPropertyName,
                                                        sentToJail: sendToJail,
                                                        chanceCard,
                                                        cardDeckName,
                                                        jailBailPaid: jailBailRequired,
                                                        rent: rentResult,
                                                        tax: taxPayment || null
                                                    });
                                                };

                                                const taxSpace =
                                                    newPosition === 4
                                                        ? { name: 'Income Tax', amount: 200 }
                                                        : newPosition === 38
                                                            ? { name: 'Luxury Tax', amount: 75 }
                                                            : null;

                                                if (!taxSpace) {
                                                    sendRollSuccess(null);
                                                    return;
                                                }

                                                updatePlayerMoney(
                                                    db,
                                                    Number(player.player_id),
                                                    Number(gameId),
                                                    -taxSpace.amount,
                                                    taxSpace.name,
                                                    (taxErr) => {
                                                        if (taxErr) {
                                                            if (
                                                                taxErr.message ===
                                                                    'Player not found, bankrupt, or insufficient funds.'
                                                            ) {
                                                                declareBankruptcy(
                                                                    db,
                                                                    Number(gameId),
                                                                    Number(player.player_id),
                                                                    null,
                                                                    taxSpace.amount,
                                                                    (
                                                                        bankruptcyErr,
                                                                        bankruptcy
                                                                    ) => {
                                                                        if (bankruptcyErr) {
                                                                            if (
                                                                                bankruptcyErr.message ===
                                                                                'The player can cover this debt by liquidating assets.'
                                                                            ) {
                                                                                sendPendingDebtResponse(
                                                                                    db,
                                                                                    res,
                                                                                    sendJson,
                                                                                    Number(gameId),
                                                                                    Number(player.player_id),
                                                                                    null,
                                                                                    taxSpace.amount,
                                                                                    taxSpace.name,
                                                                                    {
                                                                                        dice,
                                                                                        oldPosition,
                                                                                        newPosition,
                                                                                        passedGo
                                                                                    }
                                                                                );
                                                                                return;
                                                                            }

                                                                            sendJson(
                                                                                res,
                                                                                500,
                                                                                {
                                                                                    message:
                                                                                        bankruptcyErr.message,
                                                                                    dice,
                                                                                    oldPosition,
                                                                                    newPosition,
                                                                                    passedGo
                                                                                }
                                                                            );
                                                                            return;
                                                                        }

                                                                        if (io) {
                                                                            io.to(`game:${gameId}`).emit(
                                                                                'playerBankrupt',
                                                                                {
                                                                                    gameId,
                                                                                    ...bankruptcy
                                                                                }
                                                                            );
                                                                        }

                                                                        sendJson(res, 200, {
                                                                            message:
                                                                                `${bankruptcy.playerName} went bankrupt owing ` +
                                                                                `$${bankruptcy.unpaidDebt}.`,
                                                                            dice,
                                                                            oldPosition,
                                                                            newPosition,
                                                                            passedGo,
                                                                            bankruptcy
                                                                        });
                                                                    }
                                                                );
                                                                return;
                                                            }

                                                            console.error(
                                                                `${taxSpace.name} payment error:`,
                                                                taxErr
                                                            );
                                                            sendJson(res, 500, {
                                                                message:
                                                                    `Could not process ${taxSpace.name}.`,
                                                                dice,
                                                                oldPosition,
                                                                newPosition,
                                                                passedGo
                                                            });
                                                            return;
                                                        }

                                                        const taxPayment = {
                                                            gameId,
                                                            playerId: player.player_id,
                                                            playerName: player.player_name,
                                                            taxName: taxSpace.name,
                                                            amount: taxSpace.amount
                                                        };

                                                        if (io) {
                                                            io.to(`game:${gameId}`).emit(
                                                                'taxPaid',
                                                                taxPayment
                                                            );
                                                        }

                                                        sendRollSuccess(taxPayment);
                                                    }
                                                );
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
                                                        if (
                                                            chanceCard.type ===
                                                                'pay_each_player' &&
                                                            Number.isSafeInteger(
                                                                transferErr.amountOwed
                                                            )
                                                        ) {
                                                            declareBankruptcy(
                                                                db,
                                                                Number(gameId),
                                                                Number(
                                                                    player.player_id
                                                                ),
                                                                null,
                                                                transferErr.amountOwed,
                                                                (
                                                                    bankruptcyErr,
                                                                    bankruptcy
                                                                ) => {
                                                                    if (
                                                                        bankruptcyErr
                                                                    ) {
                                                                        if (
                                                                            bankruptcyErr.message ===
                                                                            'The player can cover this debt by liquidating assets.'
                                                                        ) {
                                                                            recordPendingDebtsForPlayers(
                                                                                db,
                                                                                Number(gameId),
                                                                                Number(player.player_id),
                                                                                Number(chanceCard.amount),
                                                                                `${cardDeckName} pay each player`,
                                                                                (debtErr, pendingDebtIds) => {
                                                                                    sendJson(
                                                                                        res,
                                                                                        debtErr ? 500 : 409,
                                                                                        {
                                                                                            message: debtErr
                                                                                                ? debtErr.message
                                                                                                : 'Payment is pending. Sell buildings or mortgage properties, then retry the payment to each player.',
                                                                                            pendingDebtIds,
                                                                                            dice,
                                                                                            oldPosition,
                                                                                            newPosition,
                                                                                            passedGo,
                                                                                            chanceCard,
                                                                                            cardDeckName
                                                                                        }
                                                                                    );
                                                                                }
                                                                            );
                                                                            return;
                                                                        }

                                                                        sendJson(
                                                                            res,
                                                                            500,
                                                                            {
                                                                                message:
                                                                                    bankruptcyErr.message,
                                                                                dice,
                                                                                oldPosition,
                                                                                newPosition,
                                                                                passedGo,
                                                                                chanceCard,
                                                                                cardDeckName
                                                                            }
                                                                        );
                                                                        return;
                                                                    }

                                                                    if (io) {
                                                                        io.to(`game:${gameId}`).emit(
                                                                            'playerBankrupt',
                                                                            {
                                                                                gameId,
                                                                                ...bankruptcy
                                                                            }
                                                                        );
                                                                    }

                                                                    sendJson(res, 200, {
                                                                        message:
                                                                            `${bankruptcy.playerName} went bankrupt; ` +
                                                                            `the bank took their properties and split ` +
                                                                            `their remaining cash among the other players.`,
                                                                        dice,
                                                                        oldPosition,
                                                                        newPosition,
                                                                        passedGo,
                                                                        chanceCard,
                                                                        cardDeckName,
                                                                        bankruptcy
                                                                    });
                                                                },
                                                                {
                                                                    splitCashAmongPlayers: true
                                                                }
                                                            );
                                                            return;
                                                        }

                                                        console.error(
                                                            'Chance player transfer error:',
                                                            transferErr
                                                        );
                                                        sendJson(res, 500, {
                                                            message:
                                                                `Movement succeeded, but the ${cardDeckName} card transfer could not be completed.`
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
                                                        `${cardDeckName} Repairs`,
                                                        repairMoneyErr => {
                                                            if (repairMoneyErr) {
                                                                if (
                                                                    repairMoneyErr.message ===
                                                                        'Player not found, bankrupt, or insufficient funds.'
                                                                ) {
                                                                    declareBankruptcy(
                                                                        db,
                                                                        Number(gameId),
                                                                        Number(player.player_id),
                                                                        null,
                                                                        repairCost,
                                                                        (
                                                                            bankruptcyErr,
                                                                            bankruptcy
                                                                        ) => {
                                                                            if (bankruptcyErr) {
                                                                                if (
                                                                                    bankruptcyErr.message ===
                                                                                    'The player can cover this debt by liquidating assets.'
                                                                                ) {
                                                                                    sendPendingDebtResponse(
                                                                                        db,
                                                                                        res,
                                                                                        sendJson,
                                                                                        Number(gameId),
                                                                                        Number(player.player_id),
                                                                                        null,
                                                                                        repairCost,
                                                                                        `${cardDeckName} Repairs`,
                                                                                        {
                                                                                            dice,
                                                                                            oldPosition,
                                                                                            newPosition,
                                                                                            passedGo,
                                                                                            chanceCard,
                                                                                            cardDeckName
                                                                                        }
                                                                                    );
                                                                                    return;
                                                                                }

                                                                                sendJson(
                                                                                    res,
                                                                                    500,
                                                                                    {
                                                                                        message:
                                                                                            bankruptcyErr.message,
                                                                                        dice,
                                                                                        oldPosition,
                                                                                        newPosition,
                                                                                        passedGo,
                                                                                        chanceCard,
                                                                                        cardDeckName
                                                                                    }
                                                                                );
                                                                                return;
                                                                            }

                                                                            if (io) {
                                                                                io.to(`game:${gameId}`).emit(
                                                                                    'playerBankrupt',
                                                                                    {
                                                                                        gameId,
                                                                                        ...bankruptcy
                                                                                    }
                                                                                );
                                                                            }

                                                                            sendJson(res, 200, {
                                                                                message:
                                                                                    `${bankruptcy.playerName} went bankrupt owing ` +
                                                                                    `$${bankruptcy.unpaidDebt}.`,
                                                                                dice,
                                                                                oldPosition,
                                                                                newPosition,
                                                                                passedGo,
                                                                                chanceCard,
                                                                                cardDeckName,
                                                                                bankruptcy
                                                                            });
                                                                        }
                                                                    );
                                                                    return;
                                                                }

                                                                console.error(
                                                                    'Chance repairs payment error:',
                                                                    repairMoneyErr
                                                                );
                                                                sendJson(res, 500, {
                                                                    message:
                                                                        'Movement succeeded, but the repair costs could not be paid.',
                                                                    dice,
                                                                    oldPosition,
                                                                    newPosition,
                                                                    passedGo,
                                                                    chanceCard,
                                                                    cardDeckName
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
                                            `${cardDeckName} Card`,
                                            chanceErr => {
                                                if (chanceErr) {
                                                    if (
                                                        chanceCard.type === 'pay' &&
                                                        chanceErr.message ===
                                                            'Player not found, bankrupt, or insufficient funds.'
                                                    ) {
                                                        declareBankruptcy(
                                                            db,
                                                            Number(gameId),
                                                            Number(player.player_id),
                                                            null,
                                                            Number(chanceCard.amount),
                                                            (
                                                                bankruptcyErr,
                                                                bankruptcy
                                                            ) => {
                                                                if (bankruptcyErr) {
                                                                    if (
                                                                        bankruptcyErr.message ===
                                                                        'The player can cover this debt by liquidating assets.'
                                                                    ) {
                                                                        sendPendingDebtResponse(
                                                                            db,
                                                                            res,
                                                                            sendJson,
                                                                            Number(gameId),
                                                                            Number(player.player_id),
                                                                            null,
                                                                            Number(chanceCard.amount),
                                                                            `${cardDeckName} card`,
                                                                            {
                                                                                dice,
                                                                                oldPosition,
                                                                                newPosition,
                                                                                passedGo,
                                                                                chanceCard,
                                                                                cardDeckName
                                                                            }
                                                                        );
                                                                        return;
                                                                    }

                                                                    sendJson(
                                                                        res,
                                                                        500,
                                                                        {
                                                                            message:
                                                                                bankruptcyErr.message,
                                                                            dice,
                                                                            oldPosition,
                                                                            newPosition,
                                                                            passedGo,
                                                                            chanceCard,
                                                                            cardDeckName
                                                                        }
                                                                    );
                                                                    return;
                                                                }

                                                                if (io) {
                                                                    io.to(`game:${gameId}`).emit(
                                                                        'playerBankrupt',
                                                                        {
                                                                            gameId,
                                                                            ...bankruptcy
                                                                        }
                                                                    );
                                                                }

                                                                sendJson(res, 200, {
                                                                    message:
                                                                        `${bankruptcy.playerName} went bankrupt owing ` +
                                                                        `$${bankruptcy.unpaidDebt}.`,
                                                                    dice,
                                                                    oldPosition,
                                                                    newPosition,
                                                                    passedGo,
                                                                    chanceCard,
                                                                    cardDeckName,
                                                                    bankruptcy
                                                                });
                                                            }
                                                        );
                                                        return;
                                                    }
                                                    console.error(
                                                        'Chance card money update error:',
                                                        chanceErr
                                                    );
                                                    sendJson(res, 500, {
                                                        message:
                                                            `Movement succeeded, but the ${cardDeckName} card could not be applied.`
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
                                            if (
                                                bailErr.message ===
                                                'Player not found, bankrupt, or insufficient funds.'
                                            ) {
                                                declareBankruptcy(
                                                    db,
                                                    Number(gameId),
                                                    Number(player.player_id),
                                                    null,
                                                    50,
                                                    (
                                                        bankruptcyErr,
                                                        bankruptcy
                                                    ) => {
                                                        if (bankruptcyErr) {
                                                            if (
                                                                bankruptcyErr.message ===
                                                                'The player can cover this debt by liquidating assets.'
                                                            ) {
                                                                sendPendingDebtResponse(
                                                                    db,
                                                                    res,
                                                                    sendJson,
                                                                    Number(gameId),
                                                                    Number(player.player_id),
                                                                    null,
                                                                    50,
                                                                    'Jail Bail',
                                                                    {
                                                                        dice,
                                                                        oldPosition,
                                                                        newPosition,
                                                                        passedGo
                                                                    }
                                                                );
                                                                return;
                                                            }

                                                            sendJson(
                                                                res,
                                                                500,
                                                                {
                                                                    message:
                                                                        bankruptcyErr.message,
                                                                    dice,
                                                                    oldPosition,
                                                                    newPosition,
                                                                    passedGo
                                                                }
                                                            );
                                                            return;
                                                        }

                                                        if (io) {
                                                            io.to(`game:${gameId}`).emit(
                                                                'playerBankrupt',
                                                                {
                                                                    gameId,
                                                                    ...bankruptcy
                                                                }
                                                            );
                                                        }

                                                        sendJson(res, 200, {
                                                            message:
                                                                `${bankruptcy.playerName} went bankrupt owing ` +
                                                                `$${bankruptcy.unpaidDebt}.`,
                                                            dice,
                                                            oldPosition,
                                                            newPosition,
                                                            passedGo,
                                                            bankruptcy
                                                        });
                                                    }
                                                );
                                                return;
                                            }

                                            console.error(
                                                'Jail bail payment error:',
                                                bailErr
                                            );
                                            sendJson(res, 500, {
                                                message:
                                                    'The Jail bail payment could not be completed.',
                                                dice,
                                                oldPosition,
                                                newPosition,
                                                passedGo
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

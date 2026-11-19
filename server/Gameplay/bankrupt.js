function declareBankruptcy(
    db,
    gameId,
    bankruptPlayerId,
    creditorPlayerId,
    amountOwed,
    callback,
    options = {}
) {
    if (typeof callback !== 'function') {
        return;
    }

    if (
        !Number.isSafeInteger(gameId) ||
        gameId <= 0 ||
        !Number.isSafeInteger(bankruptPlayerId) ||
        bankruptPlayerId <= 0
    ) {
        callback(new Error('Invalid bankruptcy request.'));
        return;
    }

    if (
        creditorPlayerId !== null &&
        (!Number.isSafeInteger(creditorPlayerId) || creditorPlayerId <= 0)
    ) {
        callback(new Error('Invalid creditor player ID.'));
        return;
    }

    if (!Number.isSafeInteger(amountOwed) || amountOwed <= 0) {
        callback(new Error('Invalid debt amount.'));
        return;
    }

    if (
        !options ||
        typeof options !== 'object' ||
        (options.splitCashAmongPlayers === true && creditorPlayerId !== null)
    ) {
        callback(new Error('Invalid bankruptcy settlement options.'));
        return;
    }

    const splitCashAmongPlayers =
        options.splitCashAmongPlayers === true;

    db.getConnection((connectionErr, connection) => {
        if (connectionErr) {
            callback(connectionErr);
            return;
        }

        connection.beginTransaction(beginErr => {
            if (beginErr) {
                connection.release();
                callback(beginErr);
                return;
            }

            const failTransaction = error => {
                connection.rollback(() => {
                    connection.release();
                    callback(error);
                });
            };

            const queryInTransaction = (sql, values = []) =>
                new Promise((resolve, reject) => {
                    connection.query(sql, values, (error, result) => {
                        if (error) {
                            reject(error);
                            return;
                        }

                        resolve(result);
                    });
                });

            connection.query(
                `SELECT player_id, player_name, money, is_bankrupt
                 FROM Player
                 WHERE player_id = ?
                   AND game_id = ?
                 FOR UPDATE`,
                [bankruptPlayerId, gameId],
                (playerErr, players) => {
                    if (playerErr) {
                        failTransaction(playerErr);
                        return;
                    }

                    if (
                        players.length === 0 ||
                        Number(players[0].is_bankrupt) === 1
                    ) {
                        failTransaction(
                            new Error('The player is not active in this game.')
                        );
                        return;
                    }

                    const player = players[0];

                    if (
                        creditorPlayerId !== null &&
                        Number(creditorPlayerId) === Number(player.player_id)
                    ) {
                        failTransaction(
                            new Error('A player cannot owe themselves money.')
                        );
                        return;
                    }

                    const finishValidation = creditor => {
                        connection.query(
                            `SELECT
                                 prop.property_id,
                                 prop.property_name,
                                 prop.price,
                                 prop.house_cost,
                                 prop.hotel_cost,
                                 pp.houses,
                                 pp.hotels,
                                 pp.mortgaged
                             FROM Player_Property AS pp
                             JOIN Property AS prop
                               ON prop.property_id = pp.property_id
                             WHERE pp.player_id = ?
                             FOR UPDATE`,
                            [player.player_id],
                            async (propertyErr, properties) => {
                                if (propertyErr) {
                                    failTransaction(propertyErr);
                                    return;
                                }

                                const potentialLiquidationValue =
                                    properties.reduce((total, property) => {
                                        const houseSaleValue =
                                            Math.floor(
                                                Number(property.house_cost || 0) / 2
                                            ) * Number(property.houses);
                                        const hotelSaleValue =
                                            Math.floor(
                                                Number(property.hotel_cost || 0) / 2
                                            ) * Number(property.hotels);
                                        const mortgageValue =
                                            Number(property.mortgaged) === 1
                                                ? 0
                                                : Math.floor(
                                                    Number(property.price) / 2
                                                );

                                        return (
                                            total +
                                            houseSaleValue +
                                            hotelSaleValue +
                                            mortgageValue
                                        );
                                    }, 0);

                                const shortfallIfAllAssetsSold = Math.max(
                                    0,
                                    amountOwed -
                                        Number(player.money) -
                                        potentialLiquidationValue
                                );

                                if (shortfallIfAllAssetsSold === 0) {
                                    failTransaction(
                                        new Error(
                                            'The player can cover this debt by liquidating assets.'
                                        )
                                    );
                                    return;
                                }

                                const cashTransferred = Number(player.money);

                                try {
                                    const debtorUpdate = await queryInTransaction(
                                        `UPDATE Player
                                         SET money = 0,
                                             is_bankrupt = 1,
                                             is_in_jail = 0,
                                             jail_turns = 0,
                                             consecutive_doubles = 0
                                         WHERE player_id = ?
                                           AND game_id = ?
                                           AND is_bankrupt = 0`,
                                        [player.player_id, gameId]
                                    );

                                    if (debtorUpdate.affectedRows !== 1) {
                                        throw new Error(
                                            'Could not mark the player bankrupt.'
                                        );
                                    }

                                    if (creditor) {
                                        if (cashTransferred > 0) {
                                            const creditorUpdate =
                                                await queryInTransaction(
                                                    `UPDATE Player
                                                     SET money = money + ?
                                                     WHERE player_id = ?
                                                       AND game_id = ?
                                                       AND is_bankrupt = 0`,
                                                    [
                                                        cashTransferred,
                                                        creditor.player_id,
                                                        gameId
                                                    ]
                                                );

                                            if (
                                                creditorUpdate.affectedRows !== 1
                                            ) {
                                                throw new Error(
                                                    'Could not transfer money to the creditor.'
                                                );
                                            }
                                        }

                                        await queryInTransaction(
                                            `UPDATE Player_Property
                                             SET player_id = ?
                                             WHERE player_id = ?`,
                                            [
                                                creditor.player_id,
                                                player.player_id
                                            ]
                                        );
                                    } else {
                                        await queryInTransaction(
                                            `DELETE FROM Player_Property
                                             WHERE player_id = ?`,
                                            [player.player_id]
                                        );
                                    }

                                    const activePlayers =
                                        await queryInTransaction(
                                            `SELECT player_id, player_name
                                             FROM Player
                                             WHERE game_id = ?
                                               AND is_bankrupt = 0
                                             ORDER BY player_id
                                             FOR UPDATE`,
                                            [gameId]
                                        );

                                    if (activePlayers.length === 0) {
                                        throw new Error(
                                            'No active players remain in the game.'
                                        );
                                    }

                                    const nextPlayer =
                                        activePlayers.find(
                                            activePlayer =>
                                                Number(activePlayer.player_id) >
                                                Number(player.player_id)
                                        ) || activePlayers[0];
                                    const gameComplete =
                                        activePlayers.length === 1;
                                    const cashRecipients = [];

                                    const gameUpdate =
                                        await queryInTransaction(
                                            `UPDATE Game
                                             SET current_player_id = ?,
                                                 game_status = CASE
                                                     WHEN ? = 1 THEN 'completed'
                                                     ELSE game_status
                                                 END
                                             WHERE game_id = ?
                                               AND game_status = 'in_progress'`,
                                            [
                                                nextPlayer.player_id,
                                                gameComplete ? 1 : 0,
                                                gameId
                                            ]
                                        );

                                    if (gameUpdate.affectedRows !== 1) {
                                        throw new Error(
                                            'Could not advance the game after bankruptcy.'
                                        );
                                    }

                                    if (
                                        splitCashAmongPlayers &&
                                        cashTransferred > 0
                                    ) {
                                        const baseShare = Math.floor(
                                            cashTransferred / activePlayers.length
                                        );
                                        const remainder =
                                            cashTransferred % activePlayers.length;

                                        for (
                                            let index = 0;
                                            index < activePlayers.length;
                                            index += 1
                                        ) {
                                            const recipient = activePlayers[index];
                                            const share =
                                                baseShare +
                                                (index < remainder ? 1 : 0);

                                            if (share === 0) {
                                                continue;
                                            }

                                            const recipientUpdate =
                                                await queryInTransaction(
                                                    `UPDATE Player
                                                     SET money = money + ?
                                                     WHERE player_id = ?
                                                       AND game_id = ?
                                                       AND is_bankrupt = 0`,
                                                    [
                                                        share,
                                                        recipient.player_id,
                                                        gameId
                                                    ]
                                                );

                                            if (
                                                recipientUpdate.affectedRows !==
                                                1
                                            ) {
                                                throw new Error(
                                                    'Could not distribute the bankrupt player’s cash.'
                                                );
                                            }

                                            await queryInTransaction(
                                                `INSERT INTO Game_Transaction
                                                    (
                                                        game_id,
                                                        amount,
                                                        transaction_type,
                                                        player_id
                                                    )
                                                 VALUES (?, ?, ?, ?)`,
                                                [
                                                    gameId,
                                                    share,
                                                    'Bankruptcy Card Split',
                                                    recipient.player_id
                                                ]
                                            );

                                            cashRecipients.push({
                                                playerId: Number(
                                                    recipient.player_id
                                                ),
                                                playerName:
                                                    recipient.player_name,
                                                amount: share
                                            });
                                        }
                                    }

                                    if (cashTransferred > 0) {
                                        await queryInTransaction(
                                            `INSERT INTO Game_Transaction
                                                (
                                                    game_id,
                                                    amount,
                                                    transaction_type,
                                                    player_id
                                                )
                                             VALUES (?, ?, ?, ?)`,
                                            [
                                                gameId,
                                                -cashTransferred,
                                                'Bankruptcy Payment',
                                                player.player_id
                                            ]
                                        );

                                        if (creditor) {
                                            await queryInTransaction(
                                                `INSERT INTO Game_Transaction
                                                    (
                                                        game_id,
                                                        amount,
                                                        transaction_type,
                                                        player_id
                                                    )
                                                 VALUES (?, ?, ?, ?)`,
                                                [
                                                    gameId,
                                                    cashTransferred,
                                                    'Bankruptcy Recovery',
                                                    creditor.player_id
                                                ]
                                            );
                                        }
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

                                    connection.release();
                                    callback(null, {
                                        playerId: Number(player.player_id),
                                        playerName: player.player_name,
                                        creditorPlayerId: creditor
                                            ? Number(creditor.player_id)
                                            : null,
                                        creditorName: creditor
                                            ? creditor.player_name
                                            : 'the bank',
                                        cashTransferred,
                                        splitCashAmongPlayers,
                                        cashRecipients,
                                        nextPlayerId: Number(
                                            nextPlayer.player_id
                                        ),
                                        gameComplete,
                                        amountOwed,
                                        unpaidDebt:
                                            amountOwed - cashTransferred,
                                        propertiesTransferred:
                                            properties.length
                                    });
                                } catch (error) {
                                    failTransaction(error);
                                }
                            }
                        );
                    };

                    if (creditorPlayerId === null) {
                        finishValidation(null);
                        return;
                    }

                    connection.query(
                        `SELECT player_id, player_name, money, is_bankrupt
                         FROM Player
                         WHERE player_id = ?
                           AND game_id = ?
                         FOR UPDATE`,
                        [creditorPlayerId, gameId],
                        (creditorErr, creditors) => {
                            if (creditorErr) {
                                failTransaction(creditorErr);
                                return;
                            }

                            if (
                                creditors.length === 0 ||
                                Number(creditors[0].is_bankrupt) === 1
                            ) {
                                failTransaction(
                                    new Error(
                                        'The creditor is not active in this game.'
                                    )
                                );
                                return;
                            }

                            finishValidation(creditors[0]);
                        }
                    );
                }
            );
        });
    });
}

function recordPendingDebt(
    db,
    gameId,
    debtorPlayerId,
    creditorPlayerId,
    amountDue,
    debtSource,
    callback
) {
    db.query(
        `INSERT INTO Pending_Debt
            (game_id, debtor_player_id, creditor_player_id, amount_due, debt_source)
         VALUES (?, ?, ?, ?, ?)`,
        [
            gameId,
            debtorPlayerId,
            creditorPlayerId,
            amountDue,
            debtSource
        ],
        callback
    );
}

function settlePendingDebt(db, gameId, pendingDebtId, userId, callback) {
    if (
        !Number.isSafeInteger(gameId) ||
        gameId <= 0 ||
        !Number.isSafeInteger(pendingDebtId) ||
        pendingDebtId <= 0 ||
        !Number.isSafeInteger(userId) ||
        userId <= 0
    ) {
        callback(new Error('Invalid pending debt payment request.'));
        return;
    }

    db.getConnection((connectionErr, connection) => {
        if (connectionErr) {
            callback(connectionErr);
            return;
        }

        connection.beginTransaction(beginErr => {
            if (beginErr) {
                connection.release();
                callback(beginErr);
                return;
            }

            const failTransaction = error => {
                connection.rollback(() => {
                    connection.release();
                    callback(error);
                });
            };

            connection.query(
                `SELECT
                     debt.pending_debt_id,
                     debt.amount_due,
                     debt.debt_source,
                     debt.debtor_player_id,
                     debt.creditor_player_id,
                     debtor.user_id AS debtor_user_id,
                     debtor.player_name AS debtor_name,
                     debtor.money AS debtor_money,
                     debtor.is_bankrupt AS debtor_is_bankrupt,
                     game.current_player_id,
                     game.game_status,
                     creditor.player_name AS creditor_name,
                     creditor.is_bankrupt AS creditor_is_bankrupt
                 FROM Pending_Debt AS debt
                 JOIN Player AS debtor
                   ON debtor.player_id = debt.debtor_player_id
                  AND debtor.game_id = debt.game_id
                 JOIN Game AS game
                   ON game.game_id = debt.game_id
                 LEFT JOIN Player AS creditor
                   ON creditor.player_id = debt.creditor_player_id
                  AND creditor.game_id = debt.game_id
                 WHERE debt.pending_debt_id = ?
                   AND debt.game_id = ?
                 FOR UPDATE`,
                [pendingDebtId, gameId],
                (debtErr, debts) => {
                    if (debtErr) {
                        failTransaction(debtErr);
                        return;
                    }

                    if (debts.length === 0) {
                        failTransaction(new Error('Pending debt not found.'));
                        return;
                    }

                    const debt = debts[0];
                    const amountDue = Number(debt.amount_due);

                    if (Number(debt.debtor_user_id) !== userId) {
                        failTransaction(
                            new Error('You cannot pay another player’s debt.')
                        );
                        return;
                    }

                    if (
                        debt.game_status !== 'in_progress' ||
                        Number(debt.current_player_id) !==
                            Number(debt.debtor_player_id)
                    ) {
                        failTransaction(
                            new Error('You can only retry this debt during your turn.')
                        );
                        return;
                    }

                    if (Number(debt.debtor_is_bankrupt) === 1) {
                        failTransaction(new Error('The debtor is bankrupt.'));
                        return;
                    }

                    if (Number(debt.debtor_money) < amountDue) {
                        failTransaction(
                            new Error('You still do not have enough money to pay this debt.')
                        );
                        return;
                    }

                    if (
                        debt.creditor_player_id !== null &&
                        Number(debt.creditor_is_bankrupt) === 1
                    ) {
                        failTransaction(
                            new Error('The creditor is no longer active.')
                        );
                        return;
                    }

                    const queryInTransaction = (sql, values) =>
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
                        const debtorUpdate = await queryInTransaction(
                            `UPDATE Player
                             SET money = money - ?
                             WHERE player_id = ?
                               AND game_id = ?
                               AND is_bankrupt = 0
                               AND money >= ?`,
                            [
                                amountDue,
                                debt.debtor_player_id,
                                gameId,
                                amountDue
                            ]
                        );

                        if (debtorUpdate.affectedRows !== 1) {
                            throw new Error(
                                'The payment could not be taken from your balance.'
                            );
                        }

                        await queryInTransaction(
                            `INSERT INTO Game_Transaction
                                (game_id, amount, transaction_type, player_id)
                             VALUES (?, ?, ?, ?)`,
                            [
                                gameId,
                                -amountDue,
                                'Pending Debt Payment',
                                debt.debtor_player_id
                            ]
                        );

                        if (debt.creditor_player_id !== null) {
                            await queryInTransaction(
                                `UPDATE Player
                                 SET money = money + ?
                                 WHERE player_id = ?
                                   AND game_id = ?
                                   AND is_bankrupt = 0`,
                                [amountDue, debt.creditor_player_id, gameId]
                            );

                            await queryInTransaction(
                                `INSERT INTO Game_Transaction
                                    (game_id, amount, transaction_type, player_id)
                                 VALUES (?, ?, ?, ?)`,
                                [
                                    gameId,
                                    amountDue,
                                    'Pending Debt Received',
                                    debt.creditor_player_id
                                ]
                            );
                        }

                        const deleteResult = await queryInTransaction(
                            `DELETE FROM Pending_Debt
                             WHERE pending_debt_id = ?
                               AND game_id = ?`,
                            [pendingDebtId, gameId]
                        );

                        if (deleteResult.affectedRows !== 1) {
                            throw new Error('Could not clear the paid debt.');
                        }

                        connection.commit(commitErr => {
                            if (commitErr) {
                                failTransaction(commitErr);
                                return;
                            }

                            connection.release();
                            callback(null, {
                                pendingDebtId,
                                debtorPlayerId: Number(debt.debtor_player_id),
                                debtorName: debt.debtor_name,
                                creditorPlayerId:
                                    debt.creditor_player_id === null
                                        ? null
                                        : Number(debt.creditor_player_id),
                                creditorName:
                                    debt.creditor_player_id === null
                                        ? 'the bank'
                                        : debt.creditor_name,
                                amountDue,
                                debtSource: debt.debt_source
                            });
                        });
                    })().catch(failTransaction);
                }
            );
        });
    });
}

module.exports = {
    declareBankruptcy,
    recordPendingDebt,
    settlePendingDebt
};

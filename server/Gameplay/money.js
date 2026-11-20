const { declareBankruptcyAtZero } = require('./bankrupt');

function updatePlayerMoney(db, playerId, gameId, amount, transactionType, callback) {
    if (!Number.isSafeInteger(playerId) || playerId <= 0) {
        callback(new Error('Invalid player ID.'));
        return;
    }

    if (!Number.isSafeInteger(gameId) || gameId <= 0) {
        callback(new Error('Invalid game ID.'));
        return;
    }

    if (!Number.isSafeInteger(amount) || amount === 0) {
        callback(new Error('Money amount must be a nonzero whole number.'));
        return;
    }

    if (
        typeof transactionType !== 'string' ||
        transactionType.trim() === '' ||
        transactionType.length > 45
    ) {
        callback(new Error('Invalid transaction type.'));
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

            let finished = false;

            const failTransaction = error => {
                if (finished) return;
                finished = true;

                connection.rollback(() => {
                    connection.release();
                    callback(error);
                });
            };

            connection.query(
                `UPDATE Player
                 SET money = money + ?
                 WHERE player_id = ?
                   AND game_id = ?
                   AND is_bankrupt = 0
                   AND money + ? >= 0`,
                [amount, playerId, gameId, amount],
                (updateErr, result) => {
                    if (updateErr) {
                        failTransaction(updateErr);
                        return;
                    }

                    if (result.affectedRows !== 1) {
                        failTransaction(
                            new Error('Player not found, bankrupt, or insufficient funds.')
                        );
                        return;
                    }

                    connection.query(
                        `INSERT INTO Game_Transaction
                         (game_id, amount, transaction_type, player_id)
                         VALUES (?, ?, ?, ?)`,
                        [gameId, amount, transactionType, playerId],
                        insertErr => {
                            if (insertErr) {
                                failTransaction(insertErr);
                                return;
                            }

                            connection.query(
                                `SELECT money
                                 FROM Player
                                 WHERE player_id = ? AND game_id = ?`,
                                [playerId, gameId],
                                (balanceErr, balances) => {
                                    if (balanceErr) {
                                        failTransaction(balanceErr);
                                        return;
                                    }

                                    connection.commit(commitErr => {
                                        if (commitErr) {
                                            failTransaction(commitErr);
                                            return;
                                        }

                                        if (finished) return;
                                        finished = true;
                                        connection.release();

                                        if (
                                            amount < 0 &&
                                            balances.length > 0 &&
                                            Number(balances[0].money) === 0
                                        ) {
                                            declareBankruptcyAtZero(
                                                db,
                                                gameId,
                                                playerId,
                                                null,
                                                (bankruptcyErr, bankruptcy) => {
                                                    callback(
                                                        bankruptcyErr,
                                                        { bankruptcy }
                                                    );
                                                }
                                            );
                                            return;
                                        }

                                        callback(null, null);
                                    });
                                }
                            );
                        }
                    );
                }
            );
        });
    });
}

module.exports = {
    updatePlayerMoney
};

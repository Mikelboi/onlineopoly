
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

    db.beginTransaction(err => {
        if (err) {
            callback(err);
            return;
        }

        const failTransaction = error => {
            db.rollback(() => callback(error));
        };

        db.query(
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

                db.query(
                    `INSERT INTO Game_Transaction
                     (game_id, amount, transaction_type, player_id)
                     VALUES (?, ?, ?, ?)`,
                    [gameId, amount, transactionType, playerId],
                    (insertErr) => {
                        if (insertErr) {
                            failTransaction(insertErr);
                            return;
                        }

                        db.commit(commitErr => {
                            if (commitErr) {
                                failTransaction(commitErr);
                                return;
                            }

                            callback(null);
                        });
                    }
                );
            }
        );
    });
}

module.exports = {
    updatePlayerMoney
};

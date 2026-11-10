function applyPlayerTransferCard(db, gameId, currentPlayerId, card, callback) {
    const transferAmount = Number(card && card.amount);
    const isCollection = card && card.type === 'collect_each_player';
    const isPayment = card && card.type === 'pay_each_player';

    if (
        !Number.isSafeInteger(gameId) ||
        !Number.isSafeInteger(currentPlayerId) ||
        !Number.isSafeInteger(transferAmount) ||
        transferAmount <= 0 ||
        (!isCollection && !isPayment)
    ) {
        callback(new Error('Invalid player transfer card.'));
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
                `SELECT player_id, is_bankrupt
                 FROM Player
                 WHERE game_id = ?
                 FOR UPDATE`,
                [gameId],
                (playersErr, players) => {
                    if (playersErr) {
                        failTransaction(playersErr);
                        return;
                    }

                    const currentPlayer = players.find(
                        player =>
                            Number(player.player_id) === currentPlayerId &&
                            Number(player.is_bankrupt) === 0
                    );

                    if (!currentPlayer) {
                        failTransaction(
                            new Error('The current player is unavailable.')
                        );
                        return;
                    }

                    const otherPlayers = players.filter(
                        player =>
                            Number(player.player_id) !== currentPlayerId &&
                            Number(player.is_bankrupt) === 0
                    );

                    const totalAmount = transferAmount * otherPlayers.length;

                    if (otherPlayers.length === 0) {
                        connection.commit(commitErr => {
                            if (commitErr) {
                                failTransaction(commitErr);
                                return;
                            }

                            if (finished) return;
                            finished = true;
                            connection.release();
                            callback(null, { totalAmount: 0 });
                        });
                        return;
                    }

                    const otherPlayerChange = isCollection
                        ? -transferAmount
                        : transferAmount;
                    const currentPlayerChange = isCollection
                        ? totalAmount
                        : -totalAmount;

                    const changes = [
                        ...otherPlayers.map(player => ({
                            playerId: Number(player.player_id),
                            amount: otherPlayerChange
                        })),
                        {
                            playerId: currentPlayerId,
                            amount: currentPlayerChange
                        }
                    ];

                    const applyNextChange = index => {
                        if (index >= changes.length) {
                            connection.commit(commitErr => {
                                if (commitErr) {
                                    failTransaction(commitErr);
                                    return;
                                }

                                if (finished) return;
                                finished = true;
                                connection.release();
                                callback(null, {
                                    totalAmount,
                                    otherPlayerCount: otherPlayers.length
                                });
                            });
                            return;
                        }

                        const change = changes[index];

                        connection.query(
                            `UPDATE Player
                             SET money = money + ?
                             WHERE player_id = ?
                               AND game_id = ?
                               AND is_bankrupt = 0
                               AND money + ? >= 0`,
                            [
                                change.amount,
                                change.playerId,
                                gameId,
                                change.amount
                            ],
                            (updateErr, result) => {
                                if (updateErr) {
                                    failTransaction(updateErr);
                                    return;
                                }

                                if (result.affectedRows !== 1) {
                                    failTransaction(
                                        new Error(
                                            'A player does not have enough money for this transfer.'
                                        )
                                    );
                                    return;
                                }

                                connection.query(
                                    `INSERT INTO Game_Transaction
                                     (game_id, amount, transaction_type, player_id)
                                     VALUES (?, ?, ?, ?)`,
                                    [
                                        gameId,
                                        change.amount,
                                        `${card.deckName || 'Chance'} Card Transfer`,
                                        change.playerId
                                    ],
                                    insertErr => {
                                        if (insertErr) {
                                            failTransaction(insertErr);
                                            return;
                                        }

                                        applyNextChange(index + 1);
                                    }
                                );
                            }
                        );
                    };

                    applyNextChange(0);
                }
            );
        });
    });
}

module.exports = {
    applyPlayerTransferCard
};

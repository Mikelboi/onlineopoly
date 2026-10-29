
function purchaseProperty(db, userId, gameId, callback) {
    if (!Number.isSafeInteger(userId) || userId <= 0) {
        callback(new Error('Invalid user ID.'));
        return;
    }

    if (!Number.isSafeInteger(gameId) || gameId <= 0) {
        callback(new Error('Invalid game ID.'));
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
            `SELECT player_id, player_name, position, money
             FROM Player
             WHERE user_id = ?
               AND game_id = ?
               AND is_bankrupt = 0`,
            [userId, gameId],
            (playerErr, players) => {
                if (playerErr) {
                    failTransaction(playerErr);
                    return;
                }

                if (players.length === 0) {
                    failTransaction(
                        new Error('You are not an active player in this game.')
                    );
                    return;
                }

                const player = players[0];
                const position = Number(player.position);

                db.query(
                    `SELECT property_id, property_name, price
                     FROM Property
                     WHERE board_position = ?
                     FOR UPDATE`,
                    [position],
                    (propertyErr, properties) => {
                        if (propertyErr) {
                            failTransaction(propertyErr);
                            return;
                        }

                        if (properties.length === 0) {
                            failTransaction(
                                new Error(
                                    'There is no purchasable property at this position.'
                                )
                            );
                            return;
                        }

                        const property = properties[0];

                        db.query(
                            `SELECT pp.player_id
                            FROM Player_Property pp
                            JOIN Player p ON p.player_id = pp.player_id
                            WHERE pp.property_id = ?
                            AND p.game_id = ?`,
                            [property.property_id, gameId],
                            (ownerErr, owners) => {
                                if (ownerErr) {
                                    failTransaction(ownerErr);
                                    return;
                                }

                                if (owners.length > 0) {
                                    failTransaction(
                                        new Error('This property is already owned.')
                                    );
                                    return;
                                }

                                if (
                                    Number(player.money) <
                                    Number(property.price)
                                ) {
                                    failTransaction(
                                        new Error(
                                            'You do not have enough money to buy this property.'
                                        )
                                    );
                                    return;
                                }

                                db.query(
                                    `UPDATE Player
                                     SET money = money - ?
                                     WHERE player_id = ?
                                       AND game_id = ?
                                       AND is_bankrupt = 0
                                       AND money >= ?`,
                                    [
                                        property.price,
                                        player.player_id,
                                        gameId,
                                        property.price
                                    ],
                                    (moneyErr, result) => {
                                        if (moneyErr) {
                                            failTransaction(moneyErr);
                                            return;
                                        }

                                        if (result.affectedRows !== 1) {
                                            failTransaction(
                                                new Error(
                                                    'Insufficient funds or player unavailable.'
                                                )
                                            );
                                            return;
                                        }

                                        db.query(
                                            `INSERT INTO Player_Property
                                                (player_id, property_id, houses, hotels, mortgaged)
                                             VALUES (?, ?, 0, 0, 0)`,
                                            [
                                                player.player_id,
                                                property.property_id
                                            ],
                                            ownershipErr => {
                                                if (ownershipErr) {
                                                    failTransaction(ownershipErr);
                                                    return;
                                                }

                                                db.query(
                                                    `INSERT INTO Game_Transaction
                                                        (game_id, amount, transaction_type, player_id)
                                                     VALUES (?, ?, ?, ?)`,
                                                    [
                                                        gameId,
                                                        -Number(property.price),
                                                        'Property Purchase',
                                                        player.player_id
                                                    ],
                                                    transactionErr => {
                                                        if (transactionErr) {
                                                            failTransaction(transactionErr);
                                                            return;
                                                        }

                                                        db.commit(commitErr => {
                                                            if (commitErr) {
                                                                failTransaction(commitErr);
                                                                return;
                                                            }

                                                            callback(null, {
                                                                propertyId: property.property_id,
                                                                propertyName: property.property_name,
                                                                price: Number(property.price),
                                                                playerName: player.player_name
                                                            });
                                                        });
                                                    }
                                                );
                                            }
                                        );
                                    }
                                );
                            }
                        );
                    }
                );
            }
        );
    });
}


function payRent(db, userId, gameId, callback) {
    if (!Number.isSafeInteger(userId) || userId <= 0) {
        callback(new Error('Invalid user ID.'));
        return;
    }

    if (!Number.isSafeInteger(gameId) || gameId <= 0) {
        callback(new Error('Invalid game ID.'));
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
            `SELECT player_id, position, money
             FROM Player
             WHERE user_id = ?
               AND game_id = ?
               AND is_bankrupt = 0
             FOR UPDATE`,
            [userId, gameId],
            (playerErr, players) => {
                if (playerErr) {
                    failTransaction(playerErr);
                    return;
                }

                if (players.length === 0) {
                    failTransaction(
                        new Error('You are not an active player in this game.')
                    );
                    return;
                }

                const player = players[0];

                db.query(
                    `SELECT property_id, property_name, rent
                     FROM Property
                     WHERE board_position = ?`,
                    [player.position],
                    (propertyErr, properties) => {
                        if (propertyErr) {
                            failTransaction(propertyErr);
                            return;
                        }

                       if (properties.length === 0) {
                            db.rollback(() => callback(null, {
                                rentPaid: false,
                                reason: 'No property at this position.'
                            }));
                            return;
                        }

                        const property = properties[0];

                        db.query(
                            `SELECT
                                pp.player_id,
                                p.user_id,
                                p.player_name,
                                u.username
                            FROM Player_Property pp
                            JOIN Player p
                                ON p.player_id = pp.player_id
                            JOIN User u
                                ON u.user_id = p.user_id
                            WHERE pp.property_id = ?
                                AND p.game_id = ?
                            FOR UPDATE`,
                            [property.property_id, gameId],
                            (ownerErr, owners) => {
                                if (ownerErr) {
                                    failTransaction(ownerErr);
                                    return;
                                }
                                if (owners.length === 0) {
                                    db.rollback(() => callback(null, {
                                        rentPaid: false,
                                        reason: 'This property is unowned.'
                                    }));
                                    return;
                                }

                                const owner = owners[0];

                                if (Number(owner.player_id) === Number(player.player_id)) {
                                        db.rollback(() => callback(null, {
                                            rentPaid: false,
                                            reason: 'You landed on your own property.'
                                        }));
                                        return;
                                }

                                const rent = Number(property.rent);

                                if (!Number.isFinite(rent) || rent < 0) {
                                    failTransaction(
                                        new Error('Invalid rent amount.')
                                    );
                                    return;
                                }

                                if (Number(player.money) < rent) {
                                    failTransaction(
                                        new Error('You do not have enough money to pay rent.')
                                    );
                                    return;
                                }

                                db.query(
                                    `UPDATE Player
                                     SET money = money - ?
                                     WHERE player_id = ?
                                       AND game_id = ?
                                       AND is_bankrupt = 0
                                       AND money >= ?`,
                                    [
                                        rent,
                                        player.player_id,
                                        gameId,
                                        rent
                                    ],
                                    (deductErr, deductResult) => {
                                        if (deductErr) {
                                            failTransaction(deductErr);
                                            return;
                                        }

                                        if (deductResult.affectedRows !== 1) {
                                            failTransaction(
                                                new Error('Could not deduct rent.')
                                            );
                                            return;
                                        }

                                        db.query(
                                            `UPDATE Player
                                             SET money = money + ?
                                             WHERE player_id = ?
                                               AND game_id = ?
                                               AND is_bankrupt = 0`,
                                            [
                                                rent,
                                                owner.player_id,
                                                gameId
                                            ],
                                            (creditErr, creditResult) => {
                                                if (creditErr) {
                                                    failTransaction(creditErr);
                                                    return;
                                                }

                                                if (creditResult.affectedRows !== 1) {
                                                    failTransaction(
                                                        new Error('Could not credit the property owner.')
                                                    );
                                                    return;
                                                }

                                                db.query(
                                                    `INSERT INTO Game_Transaction
                                                        (game_id, amount, transaction_type, player_id)
                                                     VALUES (?, ?, ?, ?),
                                                            (?, ?, ?, ?)`,
                                                    [
                                                        gameId,
                                                        -rent,
                                                        'Rent Paid',
                                                        player.player_id,
                                                        gameId,
                                                        rent,
                                                        'Rent Received',
                                                        owner.player_id
                                                    ],
                                                    (transactionErr) => {
                                                        if (transactionErr) {
                                                            failTransaction(transactionErr);
                                                            return;
                                                        }

                                                        db.commit(commitErr => {
                                                            if (commitErr) {
                                                                failTransaction(commitErr);
                                                                return;
                                                            }

                                                            callback(null, {
                                                                rentPaid: true,
                                                                propertyId: property.property_id,
                                                                propertyName: property.property_name,
                                                                rent,
                                                                paidBy: player.player_id,
                                                                paidTo: owner.player_id,
                                                                ownerPlayerName: owner.player_name,
                                                                ownerUsername: owner.username
                                                            });
                                                        });
                                                    }
                                                );
                                            }
                                        );
                                    }
                                );
                            }
                        );
                    }
                );
            }
        );
    });
}




module.exports = {
    purchaseProperty,
    payRent
};


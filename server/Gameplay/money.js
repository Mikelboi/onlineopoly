function updatePlayerMoney(db, playerId, amount, callback) {
    if (!Number.isSafeInteger(playerId) || playerId <= 0) {
        callback(new Error('Invalid player ID.'));
        return;
    }

    if (!Number.isSafeInteger(amount)) {
        callback(new Error('Money amount must be a whole number.'));
        return;
    }

    db.query(
        `UPDATE Player
         SET money = money + ?
         WHERE player_id = ?
           AND money + ? >= 0`,
        [amount, playerId, amount],
        (err, result) => {
            if (err) {
                callback(err);
                return;
            }

            if (result.affectedRows === 0) {
                callback(
                    new Error('Player not found or insufficient funds.')
                );
                return;
            }

            callback(null);
        }
    );
}

module.exports = {
    updatePlayerMoney
};
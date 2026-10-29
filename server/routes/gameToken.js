function handleGameTokenRequest(req, res, { db, getSession, sendJson, readJsonBody }) {
    const route = req.url.split('?')[0];

    // SELECT PLAYER TOKEN
    if (req.method === 'POST' && route === '/games/token') {
        const session = getSession(req);

        if (!session) {
            sendJson(res, 401, {
                message: 'Please log in to select a token.'
            });
            return true;
        }

        readJsonBody(req, res, requestData => {
            const gameId = Number(requestData.gameId);
            const tokenType = requestData.tokenType;

            const allowedTokens = [
                'top_hat',
                'race_car',
                'dog',
                'battleship',
                'thimble',
                'boot',
                'cat',
                'wheelbarrow',
                'duck',
                'windmill'
            ];

            if (
                !Number.isSafeInteger(gameId) ||
                gameId <= 0 ||
                !allowedTokens.includes(tokenType)
            ) {
                sendJson(res, 400, {
                    message: 'Invalid game ID or token choice.'
                });
                return;
            }

            db.query(
                `SELECT player_id
                 FROM Player
                 WHERE game_id = ? AND user_id = ?`,
                [gameId, session.userId],
                (err, players) => {
                    if (err) {
                        console.error('Find player error:', err);
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

                 db.query(
                    `UPDATE Player
                    SET token_type = ?, token_locked = 1
                    WHERE player_id = ?
                    AND game_id = ?
                    AND token_locked = 0`,
                    [tokenType, players[0].player_id, gameId],
                    (updateErr, result) => {
                        if (updateErr) {

                             if (updateErr.code === 'ER_DUP_ENTRY') {
                                sendJson(res, 409, {
                                    message: 'That token has already been chosen in this game.'
                                });
                                return;
                            }
                            console.error('Save token error:', updateErr);
                            sendJson(res, 500, {
                                message: 'Could not save your token.'
                            });
                            return;
                        }

                        if (result.affectedRows === 0) {
                            sendJson(res, 409, {
                                message: 'You have already chosen your token.'
                            });
                            return;
                        }

                        sendJson(res, 200, {
                            message: 'Token saved successfully!',
                            tokenType
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

module.exports = handleGameTokenRequest;

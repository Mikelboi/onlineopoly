function getNextPlayer(db, gameId, currentPlayerId, callback) {
    db.query(
        `SELECT player_id
         FROM Player
         WHERE game_id = ?
           AND is_bankrupt = 0
         ORDER BY player_id ASC`,
        [gameId],
        (err, players) => {
            if (err) {
                callback(err);
                return;
            }

            if (players.length === 0) {
                callback(new Error('No active players found.'));
                return;
            }

            const currentIndex = players.findIndex(
                p => Number(p.player_id) === Number(currentPlayerId)
            );

            if (currentIndex === -1) {
                callback(new Error('Current player was not found.'));
                return;
            }

            const nextIndex = (currentIndex + 1) % players.length;
            callback(null, players[nextIndex].player_id);
        }
    );
}

function handleGameTurnRequest(req, res, { db, getSession, sendJson, readJsonBody, io }) {
    const route = req.url.split('?')[0];

        if (req.method === 'POST' && route === '/games/end-turn') {
        console.log('END-TURN ROUTE REACHED');
        const session = getSession(req);
    
        if (!session) {
            sendJson(res, 401, {
                message: 'You must be logged in.'
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
                `SELECT current_player_id, game_status
                 FROM Game
                 WHERE game_id = ?`,
                [gameId],
                (err, games) => {
                    if (err) {
                        console.error('End turn error:', err);
                        sendJson(res, 500, {
                            message: 'Could not end turn.'
                        });
                        return;
                    }
    
                    if (
                        games.length === 0 ||
                        games[0].game_status !== 'in_progress'
                    ) {
                        sendJson(res, 400, {
                            message: 'This game is not in progress.'
                        });
                        return;
                    }
    
                    const currentPlayerId = games[0].current_player_id;
    
                    db.query(
                        `SELECT player_id
                         FROM Player
                         WHERE player_id = ?
                           AND game_id = ?
                           AND user_id = ?
                           AND is_bankrupt = 0`,
                        [currentPlayerId, gameId, session.userId],
                        (playerErr, players) => {
                            if (playerErr) {
                                console.error('End turn player error:', playerErr);
                                sendJson(res, 500, {
                                    message: 'Could not verify the current player.'
                                });
                                return;
                            }
    
                            if (players.length === 0) {
                                sendJson(res, 403, {
                                    message: 'It is not your turn.'
                                });
                                return;
                            }
    
                            getNextPlayer(
                                db,
                                gameId,
                                currentPlayerId,
                                (nextErr, nextPlayerId) => {
                                    if (nextErr) {
                                        console.error('Next player error:', nextErr);
                                        sendJson(res, 500, {
                                            message: 'Could not find the next player.'
                                        });
                                        return;
                                    }
    
                                    console.log('Current player ID:', currentPlayerId);
                                    console.log('Next player ID:', nextPlayerId);
    
                                    db.query(
                                        `UPDATE Game
                                         SET current_player_id = ?
                                         WHERE game_id = ?
                                           AND current_player_id = ?`,
                                        [nextPlayerId, gameId, currentPlayerId],
                                        (updateErr, result) => {
                                            if (updateErr) {
                                                console.error('Advance turn error:', updateErr);
                                                sendJson(res, 500, {
                                                    message: 'Could not advance the turn.'
                                                });
                                                return;
                                            }
    
                                            if (result.affectedRows === 0) {
                                                sendJson(res, 409, {
                                                    message: 'The turn has already changed.'
                                                });
                                                return;
                                            }
    
                                            if (io) {
                                                io.to(`game:${gameId}`).emit('turnChanged', {
                                                    gameId,
                                                    currentPlayerId: nextPlayerId
                                                });
                                            }

                                            sendJson(res, 200, {
                                                message: 'Turn ended successfully.',
                                                currentPlayerId: nextPlayerId
                                            });
                                        }
                                    );
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

module.exports = { getNextPlayer, handleGameTurnRequest };

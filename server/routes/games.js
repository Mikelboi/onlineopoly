const { sendJson, getSession: getSessionFromCookie } = require('./httpHelpers');
const handleGameLobbyRequest = require('./gameLobby');
const handleGameTokenRequest = require('./gameToken');
const handleGameMovementRequest = require('./gameMovement');
const handleGameAuctionRequest = require('./gameAuctions');
const handleGamePropertyRequest = require('./gameProperties');
const { getNextPlayer, handleGameTurnRequest } = require('./gameTurns');

function advanceAuctionTurn(connection, gameId, startingPlayerId, callback) {
    connection.query(
        `SELECT current_player_id
         FROM Game
         WHERE game_id = ?
           AND game_status = 'in_progress'
         FOR UPDATE`,
        [gameId],
        (gameErr, games) => {
            if (gameErr) {
                callback(gameErr);
                return;
            }

            if (games.length === 0) {
                callback(new Error('Game is not in progress.'));
                return;
            }

            const currentPlayerId = Number(games[0].current_player_id);

            // Only advance if the auction starter still owns the turn.
            if (currentPlayerId !== Number(startingPlayerId)) {
                callback(null, false);
                return;
            }

            getNextPlayer(
                connection,
                gameId,
                startingPlayerId,
                (nextErr, nextPlayerId) => {
                    if (nextErr) {
                        callback(nextErr);
                        return;
                    }

                    connection.query(
                        `UPDATE Game
                         SET current_player_id = ?
                         WHERE game_id = ?
                           AND current_player_id = ?`,
                        [nextPlayerId, gameId, startingPlayerId],
                        (updateErr, result) => {
                            if (updateErr) {
                                callback(updateErr);
                                return;
                            }

                            if (result.affectedRows !== 1) {
                                callback(
                                    new Error('Could not advance the auction turn.')
                                );
                                return;
                            }

                            callback(null, true);
                        }
                    );
                }
            );
        }
    );
}

function handleGameRequest(req, res, {
    db,
    sessions,
    SESSION_DURATION,
    io
}) {
    const route = req.url.split('?')[0];

    const getSession = req => getSessionFromCookie(req, sessions, true);

    function readJsonBody(req, res, callback) {
        let body = '';
        let tooLarge = false;

        req.on('data', chunk => {
            if (tooLarge) return;

            body += chunk;

            if (Buffer.byteLength(body, 'utf8') > 10000) {
                tooLarge = true;
                sendJson(res, 413, {
                    message: 'Request too large.'
                });
            }
        });

        req.on('end', () => {
            if (tooLarge) return;

            let requestData;

            try {
                requestData = JSON.parse(body);
            } catch (error) {
                sendJson(res, 400, {
                    message: 'Invalid request body.'
                });
                return;
            }

            callback(requestData);
        });

        req.on('error', error => {
            console.error('Request body error:', error);

            if (!res.headersSent) {
                sendJson(res, 400, {
                    message: 'Could not read request body.'
                });
            }
        });
    }

    if (handleGameLobbyRequest(req, res, { db, getSession, sendJson, readJsonBody, io })) {
        return true;
    }

    if (handleGameTokenRequest(req, res, { db, getSession, sendJson, readJsonBody })) {
        return true;
    }

    if (handleGameMovementRequest(req, res, { db, getSession, sendJson, readJsonBody, io })) {
        return true;
    }

    if (handleGameAuctionRequest(req, res, { db, getSession, sendJson, readJsonBody, io, advanceAuctionTurn })) {
        return true;
    }

    if (handleGamePropertyRequest(req, res, { db, getSession, sendJson, readJsonBody, io })) {
        return true;
    }

    if (handleGameTurnRequest(req, res, { db, getSession, sendJson, readJsonBody, io })) {
        return true;
    }

    return false;
}

module.exports = handleGameRequest;

function handleGameAuctionRequest(req, res, { db, getSession, sendJson, readJsonBody, io, advanceAuctionTurn }) {
    const route = req.url.split('?')[0];

    // START PROPERTY AUCTION
    if (req.method === 'POST' && route === '/games/auction/start') {
        const session = getSession(req);

        if (!session) {
            sendJson(res, 401, {
                message: 'Please log in to start an auction.'
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
                        console.error('Auction game lookup error:', gameErr);
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
                        `SELECT player_id, player_name, position
                         FROM Player
                         WHERE game_id = ?
                           AND user_id = ?
                           AND is_bankrupt = 0`,
                        [gameId, session.userId],
                        (playerErr, players) => {
                            if (playerErr) {
                                console.error('Auction player lookup error:', playerErr);
                                sendJson(res, 500, {
                                    message: 'Could not find your player.'
                                });
                                return;
                            }

                            if (players.length === 0) {
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

                            // Find the property at the player's current position.
                            db.query(
                                `SELECT property_id, property_name
                                 FROM Property
                                 WHERE board_position = ?`,
                                [player.position],
                                (propertyErr, properties) => {
                                    if (propertyErr) {
                                        console.error('Auction property lookup error:', propertyErr);
                                        sendJson(res, 500, {
                                            message: 'Could not find the property.'
                                        });
                                        return;
                                    }

                                    if (properties.length === 0) {
                                        sendJson(res, 409, {
                                            message: 'There is no property to auction at this position.'
                                        });
                                        return;
                                    }

                                    const property = properties[0];

                                    db.query(
                                        `SELECT Player_Property.player_id
                                         FROM Player_Property
                                         JOIN Player
                                           ON Player.player_id = Player_Property.player_id
                                         WHERE Player_Property.property_id = ?
                                           AND Player.game_id = ?`,
                                        [property.property_id, gameId],
                                        (ownerErr, owners) => {
                                            if (ownerErr) {
                                                console.error('Auction ownership lookup error:', ownerErr);
                                                sendJson(res, 500, {
                                                    message: 'Could not check property ownership.'
                                                });
                                                return;
                                            }

                                            if (owners.length > 0) {
                                                sendJson(res, 409, {
                                                    message: 'This property is already owned.'
                                                });
                                                return;
                                            }

                                            db.query(
                                                `SELECT auction_id
                                                 FROM Property_Auction
                                                 WHERE game_id = ?
                                                   AND auction_status = 'open'`,
                                                [gameId],
                                                (auctionErr, openAuctions) => {
                                                    if (auctionErr) {
                                                        console.error('Open auction lookup error:', auctionErr);
                                                        sendJson(res, 500, {
                                                            message: 'Could not check active auctions.'
                                                        });
                                                        return;
                                                    }

                                                    if (openAuctions.length > 0) {
                                                        sendJson(res, 409, {
                                                            message: 'An auction is already open in this game.'
                                                        });
                                                        return;
                                                    }

                                                    db.query(
                                                        `INSERT INTO Property_Auction
                                                            (game_id, property_id, starting_player_id,
                                                            highest_bid, highest_bidder_id,
                                                            auction_status, ends_at)
                                                        VALUES (?, ?, ?, 0, NULL, 'open',
                                                                DATE_ADD(NOW(), INTERVAL 30 SECOND))`,
                                                        [gameId, property.property_id, player.player_id],
                                                        (insertErr, result) => {
                                                            if (insertErr) {
                                                                console.error('Create auction error:', insertErr);
                                                                sendJson(res, 500, {
                                                                    message: 'Could not start the auction.'
                                                                });
                                                                return;
                                                            }

                                                            
                                                            if (io) {
                                                                io.to(`game:${gameId}`).emit('auctionStarted', {
                                                                    gameId,
                                                                    auctionId: result.insertId,
                                                                    propertyId: property.property_id,
                                                                    propertyName: property.property_name,
                                                                    startingPlayerId: player.player_id,
                                                                    endsAt: new Date(Date.now() + 30000).toISOString()
                                                                });
                                                            }


                                                            sendJson(res, 201, {
                                                                message: 'Auction started successfully!',
                                                                auctionId: result.insertId,
                                                                propertyId: property.property_id,
                                                                propertyName: property.property_name,
                                                                endsAt: new Date(Date.now() + 30000).toISOString()
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

        return true;
    }

    
    // PLACE AUCTION BID
    if (req.method === 'POST' && route === '/games/auction/bid') {
        const session = getSession(req);

        if (!session) {
            sendJson(res, 401, {
                message: 'Please log in to bid.'
            });
            return true;
        }

        readJsonBody(req, res, requestData => {
            const gameId = Number(requestData.gameId);
            const auctionId = Number(requestData.auctionId);
            const bid = Number(requestData.bid);

            if (
                !Number.isSafeInteger(gameId) ||
                gameId <= 0 ||
                !Number.isSafeInteger(auctionId) ||
                auctionId <= 0 ||
                !Number.isFinite(bid) ||
                bid <= 0 ||
                Math.round(bid * 100) !== bid * 100
            ) {
                sendJson(res, 400, {
                    message: 'Enter a valid game, auction, and bid amount.'
                });
                return;
            }

            db.query(
                `SELECT player_id, player_name, money
                 FROM Player
                 WHERE game_id = ?
                   AND user_id = ?
                   AND is_bankrupt = 0`,
                [gameId, session.userId],
                (playerErr, players) => {
                    if (playerErr) {
                        console.error('Auction bidder lookup error:', playerErr);
                        sendJson(res, 500, {
                            message: 'Could not find your player.'
                        });
                        return;
                    }

                    if (players.length === 0) {
                        sendJson(res, 403, {
                            message: 'You are not an active player in this game.'
                        });
                        return;
                    }

                    const player = players[0];

                    db.query(
                        `SELECT auction_id, property_id, highest_bid,
                                highest_bidder_id, auction_status, ends_at
                         FROM Property_Auction
                         WHERE auction_id = ? AND game_id = ?`,
                        [auctionId, gameId],
                        (auctionErr, auctions) => {
                            if (auctionErr) {
                                console.error('Auction lookup error:', auctionErr);
                                sendJson(res, 500, {
                                    message: 'Could not load the auction.'
                                });
                                return;
                            }

                            if (
                                auctions.length === 0 ||
                                auctions[0].auction_status !== 'open'
                            ) {
                                sendJson(res, 409, {
                                    message: 'This auction is not open.'
                                });
                                return;
                            }

                            const auction = auctions[0];

                            if (new Date(auction.ends_at).getTime() <= Date.now()) {
                                sendJson(res, 409, {
                                    message: 'The bidding time has expired.'
                                });
                                return;
                            }

                            if (Number(player.money) < bid) {
                                sendJson(res, 400, {
                                    message: 'You do not have enough money for this bid.'
                                });
                                return;
                            }

                            if (bid <= Number(auction.highest_bid)) {
                                sendJson(res, 400, {
                                    message: 'Your bid must be higher than the current highest bid.'
                                });
                                return;
                            }

                            if (
                                Number(auction.highest_bidder_id) ===
                                Number(player.player_id)
                            ) {
                                sendJson(res, 409, {
                                    message: 'You already have the highest bid.'
                                });
                                return;
                            }

                            db.query(
                                `UPDATE Property_Auction
                                 SET highest_bid = ?,
                                     highest_bidder_id = ?
                                 WHERE auction_id = ?
                                   AND game_id = ?
                                   AND auction_status = 'open'
                                   AND ends_at > NOW()
                                   AND highest_bid < ?`,
                                [
                                    bid,
                                    player.player_id,
                                    auctionId,
                                    gameId,
                                    bid
                                ],
                                (updateErr, result) => {
                                    if (updateErr) {
                                        console.error('Save auction bid error:', updateErr);
                                        sendJson(res, 500, {
                                            message: 'Could not save your bid.'
                                        });
                                        return;
                                    }

                                    if (result.affectedRows === 0) {
                                        sendJson(res, 409, {
                                            message: 'The auction changed or expired. Refresh and try again.'
                                        });
                                        return;
                                    }

                                    
                                    if (io) {
                                        io.to(`game:${gameId}`).emit('auctionBidUpdated', {
                                            gameId,
                                            auctionId,
                                            highestBid: bid,
                                            highestBidderId: player.player_id,
                                            highestBidderName: player.player_name
                                        });
                                    }


                                    sendJson(res, 200, {
                                        message: 'Bid placed successfully!',
                                        auctionId,
                                        highestBid: bid,
                                        highestBidderId: player.player_id
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

    
    // FINISH PROPERTY AUCTION
    if (req.method === 'POST' && route === '/games/auction/finish') {
        const session = getSession(req);

        if (!session) {
            sendJson(res, 401, {
                message: 'Please log in to finish an auction.'
            });
            return true;
        }

        readJsonBody(req, res, requestData => {
            const gameId = Number(requestData.gameId);
            const auctionId = Number(requestData.auctionId);

            if (
                !Number.isSafeInteger(gameId) || gameId <= 0 ||
                !Number.isSafeInteger(auctionId) || auctionId <= 0
            ) {
                sendJson(res, 400, {
                    message: 'Invalid game or auction ID.'
                });
                return;
            }

            // Verify that the requester is an active player in this game.
            db.query(
                `SELECT player_id
                 FROM Player
                 WHERE game_id = ?
                   AND user_id = ?
                   AND is_bankrupt = 0`,
                [gameId, session.userId],
                (playerErr, players) => {
                    if (playerErr) {
                        console.error('Auction finisher lookup error:', playerErr);
                        sendJson(res, 500, {
                            message: 'Could not verify your player.'
                        });
                        return;
                    }

                    if (players.length === 0) {
                        sendJson(res, 403, {
                            message: 'You are not an active player in this game.'
                        });
                        return;
                    }

                    
            db.getConnection((connectionErr, connection) => {
                if (connectionErr) {
                    console.error('Auction connection error:', connectionErr);
                    sendJson(res, 500, {
                        message: 'Could not connect to the database for auction finalization.'
                    });
                    return;
                }

                connection.beginTransaction(transactionErr => {
                    if (transactionErr) {
                        console.error('Auction transaction error:', transactionErr);
                        connection.release();

                        sendJson(res, 500, {
                            message: 'Could not begin auction finalization.'
                        });
                        return;
                    }

                    connection.query(
                        `SELECT auction_id, property_id, starting_player_id,
                                highest_bid, highest_bidder_id,
                                auction_status, ends_at
                        FROM Property_Auction
                        WHERE auction_id = ? AND game_id = ?
                        FOR UPDATE`,
                        [auctionId, gameId],
                        (auctionErr, auctions) => {
                                if (auctionErr || auctions.length === 0) {
                                    return connection.rollback(() => {
                                        connection.release();
                                        console.error(
                                            'Auction lookup error:',
                                            auctionErr
                                        );

                                        sendJson(res, auctionErr ? 500 : 404, {
                                            message: auctionErr
                                                ? 'Could not load the auction.'
                                                : 'Auction not found.'
                                        });
                                    });
                                }

                                const auction = auctions[0];

                                if (auction.auction_status !== 'open') {
                                    return connection.rollback(() => {
                                        connection.release();
        
                                        sendJson(res, 409, {
                                            message: 'This auction has already finished.'
                                        });
                                    });
                                }

                                if (
                                    !auction.ends_at ||
                                    new Date(auction.ends_at).getTime() > Date.now()
                                ) {
                                    return connection.rollback(() => {
                                        connection.release();
                                        sendJson(res, 409, {
                                            message: 'The auction timer has not expired yet.'
                                        });
                                    });
                                }

                                // NO BIDS: close the auction and end the starter's turn.
                                if (!auction.highest_bidder_id) {
                                    connection.query(
                                        `UPDATE Property_Auction
                                         SET auction_status = 'no_bids'
                                         WHERE auction_id = ?
                                           AND auction_status = 'open'`,
                                        [auctionId],
                                        updateErr => {
                                            if (updateErr) {
                                                return connection.rollback(() => {
                                                    connection.release();
                                                    console.error(
                                                        'Close no-bid auction error:',
                                                        updateErr
                                                    );

                                                    sendJson(res, 500, {
                                                        message: 'Could not close the auction.'
                                                    });
                                                });
                                            }

                                            advanceAuctionTurn(
                                                connection,
                                                gameId,
                                                auction.starting_player_id,
                                                (turnErr, turnAdvanced) => {
                                                    if (turnErr) {
                                                        return connection.rollback(() => {
                                                            connection.release();
                                                            console.error(
                                                                'Advance auction turn error:',
                                                                turnErr
                                                            );

                                                            sendJson(res, 500, {
                                                                message: 'Could not advance the turn after the auction.'
                                                            });
                                                        });
                                                    }

                                                    connection.commit(commitErr => {
                                                        if (commitErr) {
                                                            return connection.rollback(() => {
                                                                connection.release();

                                                                console.error(
                                                                    'Auction commit error:',
                                                                    commitErr
                                                                );

                                                                sendJson(res, 500, {
                                                                    message: 'Could not save the auction result.'
                                                                });
                                                            });
                                                        }

                                                        connection.release();

                                                        if (io) {
                                                            io.to(`game:${gameId}`).emit(
                                                                'auctionFinished',
                                                                {
                                                                    gameId,
                                                                    auctionId,
                                                                    propertyId: auction.property_id,
                                                                    propertyName: null,
                                                                    winnerPlayerId: null,
                                                                    winnerPlayerName: null,
                                                                    winningBid: 0,
                                                                    status: 'no_bids',
                                                                    turnAdvanced
                                                                }
                                                            );
                                                        }

                                                        sendJson(res, 200, {
                                                            message: 'Auction ended with no bids.',
                                                            auctionId,
                                                            status: 'no_bids',
                                                            turnAdvanced
                                                        });
                                                    });
                                                }
                                            );
                                        }
                                    );

                                    return;
                                }

                                // Look up the winner and property names.
                                connection.query(
                                    `SELECT
                                        Player.player_name,
                                        Property.property_name
                                     FROM Player
                                     JOIN Property
                                       ON Property.property_id = ?
                                     WHERE Player.player_id = ?
                                       AND Player.game_id = ?`,
                                    [
                                        auction.property_id,
                                        auction.highest_bidder_id,
                                        gameId
                                    ],
                                    (winnerErr, winnerRows) => {
                                        if (winnerErr || winnerRows.length === 0) {
                                            return connection.rollback(() => {
                                                connection.release();
                                                console.error(
                                                    'Auction winner lookup error:',
                                                    winnerErr
                                                );

                                                sendJson(res, 500, {
                                                    message: 'Could not find the auction winner.'
                                                });
                                            });
                                        }

                                        const winnerPlayerName =
                                            winnerRows[0].player_name;

                                        const propertyName =
                                            winnerRows[0].property_name;

                                        // Deduct the winning bid.
                                        connection.query(
                                            `UPDATE Player
                                             SET money = money - ?
                                             WHERE player_id = ?
                                               AND game_id = ?
                                               AND is_bankrupt = 0
                                               AND money >= ?`,
                                            [
                                                auction.highest_bid,
                                                auction.highest_bidder_id,
                                                gameId,
                                                auction.highest_bid
                                            ],
                                            (paymentErr, paymentResult) => {

                                                console.log('Auction payment error:', paymentErr);
                                                console.log('Winning bid:', auction.highest_bid);
                                                console.log('Winning player ID:', auction.highest_bidder_id);
                                                console.log('Rows updated:', paymentResult?.affectedRows);
                                                if (
                                                    paymentErr ||
                                                    !paymentResult ||
                                                    paymentResult.affectedRows !== 1
                                                ) {
                                                    return connection.rollback(() => {
                                                        connection.release();
                                                        console.error(
                                                            'Auction payment error:',
                                                            paymentErr
                                                        );

                                                        sendJson(res, 409, {
                                                            message:
                                                                'The winning bidder no longer has enough money. The auction was not finalized.'
                                                        });
                                                    });
                                                }

                                                // Award the property to the winner.
                                                connection.query(
                                                    `INSERT INTO Player_Property
                                                        (player_id, property_id)
                                                     VALUES (?, ?)`,
                                                    [
                                                        auction.highest_bidder_id,
                                                        auction.property_id
                                                    ],
                                                    propertyErr => {
                                                        if (propertyErr) {
                                                            return connection.rollback(() => {
                                                                connection.release();
                                                                console.error(
                                                                    'Award auction property error:',
                                                                    propertyErr
                                                                );

                                                                sendJson(res, 500, {
                                                                    message: 'Could not award the property.'
                                                                });
                                                            });
                                                        }

                                                        // Mark the auction completed.
                                                        connection.query(
                                                            `UPDATE Property_Auction
                                                             SET auction_status = 'completed'
                                                             WHERE auction_id = ?
                                                               AND auction_status = 'open'`,
                                                            [auctionId],
                                                            (statusErr, statusResult) => {
                                                                if (
                                                                    statusErr ||
                                                                    !statusResult ||
                                                                    statusResult.affectedRows !== 1
                                                                ) {
                                                                    return connection.rollback(() => {
                                                                        connection.release();
                                                                        console.error(
                                                                            'Update auction status error:',
                                                                            statusErr
                                                                        );

                                                                        sendJson(res, 500, {
                                                                            message: 'Could not save the auction result.'
                                                                        });
                                                                    });
                                                                }

                                                                // End the auction starter's turn.
                                                                advanceAuctionTurn(
                                                                    connection,
                                                                    gameId,
                                                                    auction.starting_player_id,
                                                                    (turnErr, turnAdvanced) => {
                                                                        if (turnErr) {
                                                                            return connection.rollback(() => {
                                                                                connection.release();
                                                                                console.error(
                                                                                    'Advance auction turn error:',
                                                                                    turnErr
                                                                                );

                                                                                sendJson(res, 500, {
                                                                                    message: 'Could not advance the turn after the auction.'
                                                                                });
                                                                            });
                                                                        }

                                                                        // Commit the auction and turn update together.
                                                                        connection.commit(commitErr => {
                                                                            if (commitErr) {
                                                                                return connection.rollback(() => {
                                                                                    connection.release();
                                                                                    console.error(
                                                                                        'Auction commit error:',
                                                                                        commitErr
                                                                                    );

                                                                                    sendJson(res, 500, {
                                                                                        message: 'Could not save the auction result.'
                                                                                    });
                                                                                });
                                                                            }
                                                                            connection.release();

                                                                            if (io) {
                                                                                io.to(`game:${gameId}`).emit(
                                                                                    'auctionFinished',
                                                                                    {
                                                                                        gameId,
                                                                                        auctionId,
                                                                                        propertyId: auction.property_id,
                                                                                        propertyName,
                                                                                        winnerPlayerId:
                                                                                            auction.highest_bidder_id,
                                                                                        winnerPlayerName,
                                                                                        winningBid: Number(
                                                                                            auction.highest_bid
                                                                                        ),
                                                                                        status: 'completed',
                                                                                        turnAdvanced
                                                                                    }
                                                                                );
                                                                            }

                                                                            sendJson(res, 200, {
                                                                                message:
                                                                                    'Auction finished and property awarded!',
                                                                                auctionId,
                                                                                propertyId: auction.property_id,
                                                                                propertyName,
                                                                                winnerPlayerId:
                                                                                    auction.highest_bidder_id,
                                                                                winnerPlayerName,
                                                                                winningBid: Number(
                                                                                    auction.highest_bid
                                                                                ),
                                                                                status: 'completed',
                                                                                turnAdvanced
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
            );
        });
    });

        return true;
    }

    return false;
}

module.exports = handleGameAuctionRequest;

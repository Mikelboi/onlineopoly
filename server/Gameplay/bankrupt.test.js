// command to run test is npm test

const test = require('node:test');
const assert = require('node:assert/strict');

const { declareBankruptcy } = require('./bankrupt');

function createFakeDatabase({ players, properties, ownership, game }) {
    const state = {
        players: players.map(player => ({ ...player })),
        properties: properties.map(property => ({ ...property })),
        ownership: ownership.map(row => ({ ...row })),
        game: { ...game },
        transactions: []
    };

    const connection = {
        snapshot: null,

        beginTransaction(callback) {
            this.snapshot = {
                players: state.players.map(player => ({ ...player })),
                ownership: state.ownership.map(row => ({ ...row })),
                game: { ...state.game },
                transactions: state.transactions.map(row => ({ ...row }))
            };
            callback(null);
        },

        rollback(callback) {
            state.players = this.snapshot.players;
            state.ownership = this.snapshot.ownership;
            state.game = this.snapshot.game;
            state.transactions = this.snapshot.transactions;
            callback(null);
        },

        commit(callback) {
            callback(null);
        },

        release() {},

        query(sql, values, callback) {
            const normalizedSql = sql.replace(/\s+/g, ' ').trim().toLowerCase();

            if (
                normalizedSql.includes('from player where player_id = ?') &&
                normalizedSql.includes('and game_id = ?')
            ) {
                const player = state.players.find(
                    item =>
                        Number(item.player_id) === Number(values[0]) &&
                        Number(item.game_id) === Number(values[1])
                );
                callback(null, player ? [{ ...player }] : []);
                return;
            }

            if (normalizedSql.includes('from player_property as pp')) {
                const playerId = Number(values[0]);
                const rows = state.ownership
                    .filter(row => Number(row.player_id) === playerId)
                    .map(row => {
                        const property = state.properties.find(
                            item =>
                                Number(item.property_id) ===
                                Number(row.property_id)
                        );
                        return {
                            ...property,
                            ...row
                        };
                    });
                callback(null, rows);
                return;
            }

            if (normalizedSql.startsWith('update player set money = 0')) {
                const player = state.players.find(
                    item =>
                        Number(item.player_id) === Number(values[0]) &&
                        Number(item.game_id) === Number(values[1]) &&
                        Number(item.is_bankrupt) === 0
                );
                if (player) {
                    player.money = 0;
                    player.is_bankrupt = 1;
                    player.is_in_jail = 0;
                    player.jail_turns = 0;
                    player.consecutive_doubles = 0;
                }
                callback(null, { affectedRows: player ? 1 : 0 });
                return;
            }

            if (normalizedSql.startsWith('update player set money = money + ?')) {
                const [amount, playerId, gameId] = values;
                const player = state.players.find(
                    item =>
                        Number(item.player_id) === Number(playerId) &&
                        Number(item.game_id) === Number(gameId) &&
                        Number(item.is_bankrupt) === 0
                );
                if (player) {
                    player.money = Number(player.money) + Number(amount);
                }
                callback(null, { affectedRows: player ? 1 : 0 });
                return;
            }

            if (normalizedSql.startsWith('update player_property set player_id = ?')) {
                const [newPlayerId, oldPlayerId] = values;
                state.ownership.forEach(row => {
                    if (Number(row.player_id) === Number(oldPlayerId)) {
                        row.player_id = Number(newPlayerId);
                    }
                });
                callback(null, { affectedRows: 1 });
                return;
            }

            if (normalizedSql.startsWith('delete from player_property')) {
                const oldPlayerId = Number(values[0]);
                const beforeCount = state.ownership.length;
                state.ownership = state.ownership.filter(
                    row => Number(row.player_id) !== oldPlayerId
                );
                callback(null, {
                    affectedRows: beforeCount - state.ownership.length
                });
                return;
            }

            if (
                normalizedSql.includes('from player where game_id = ?') &&
                normalizedSql.includes('is_bankrupt = 0')
            ) {
                callback(
                    null,
                    state.players
                        .filter(
                            player =>
                                Number(player.game_id) === Number(values[0]) &&
                                Number(player.is_bankrupt) === 0
                        )
                        .sort((left, right) => left.player_id - right.player_id)
                        .map(({ player_id, player_name }) => ({
                            player_id,
                            player_name
                        }))
                );
                return;
            }

            if (normalizedSql.startsWith('update game set current_player_id = ?')) {
                const [currentPlayerId, isComplete, gameId] = values;
                const matches =
                    Number(state.game.game_id) === Number(gameId) &&
                    state.game.game_status === 'in_progress';
                if (matches) {
                    state.game.current_player_id = Number(currentPlayerId);
                    if (Number(isComplete) === 1) {
                        state.game.game_status = 'completed';
                    }
                }
                callback(null, { affectedRows: matches ? 1 : 0 });
                return;
            }

            if (normalizedSql.startsWith('insert into game_transaction')) {
                state.transactions.push({
                    game_id: Number(values[0]),
                    amount: Number(values[1]),
                    transaction_type: values[2],
                    player_id: Number(values[3])
                });
                callback(null, { affectedRows: 1 });
                return;
            }

            callback(new Error(`Unexpected fake database query: ${sql}`));
        }
    };

    return {
        state,
        getConnection(callback) {
            callback(null, connection);
        }
    };
}

function declareBankruptcyAsync(db, gameId, debtorId, creditorId, amount, options) {
    return new Promise((resolve, reject) => {
        declareBankruptcy(
            db,
            gameId,
            debtorId,
            creditorId,
            amount,
            (error, result) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve(result);
            },
            options
        );
    });
}

function player(playerId, name, money, isBankrupt = 0) {
    return {
        player_id: playerId,
        player_name: name,
        money,
        is_bankrupt: isBankrupt,
        is_in_jail: 0,
        jail_turns: 0,
        consecutive_doubles: 0,
        game_id: 1
    };
}

function game(gameId = 1) {
    return {
        game_id: gameId,
        current_player_id: 1,
        game_status: 'in_progress'
    };
}

test('does not declare bankruptcy when cash and liquidation value cover the debt', async () => {
    const db = createFakeDatabase({
        players: [player(1, 'Debtor', 25), player(2, 'Creditor', 500)],
        properties: [
            {
                property_id: 10,
                property_name: 'Test Street',
                price: 100,
                house_cost: 50,
                hotel_cost: 200
            }
        ],
        ownership: [
            {
                player_id: 1,
                property_id: 10,
                houses: 1,
                hotels: 0,
                mortgaged: 0
            }
        ],
        game: game()
    });

    await assert.rejects(
        declareBankruptcyAsync(db, 1, 1, 2, 100),
        /can cover this debt by liquidating assets/
    );

    assert.equal(db.state.players[0].is_bankrupt, 0);
    assert.equal(db.state.players[0].money, 25);
    assert.equal(db.state.game.current_player_id, 1);
    assert.equal(db.state.transactions.length, 0);
});

test('declares bankruptcy and transfers cash and properties to a player creditor', async () => {
    const db = createFakeDatabase({
        players: [player(1, 'Debtor', 25), player(2, 'Creditor', 500)],
        properties: [
            {
                property_id: 10,
                property_name: 'Test Street',
                price: 100,
                house_cost: 50,
                hotel_cost: 200
            }
        ],
        ownership: [
            {
                player_id: 1,
                property_id: 10,
                houses: 1,
                hotels: 0,
                mortgaged: 0
            }
        ],
        game: game()
    });

    const result = await declareBankruptcyAsync(db, 1, 1, 2, 300);

    assert.equal(result.playerId, 1);
    assert.equal(result.creditorPlayerId, 2);
    assert.equal(result.cashTransferred, 25);
    assert.equal(result.unpaidDebt, 275);
    assert.equal(result.propertiesTransferred, 1);
    assert.equal(result.gameComplete, true);
    assert.equal(db.state.players[0].is_bankrupt, 1);
    assert.equal(db.state.players[0].money, 0);
    assert.equal(db.state.players[1].money, 525);
    assert.equal(db.state.ownership[0].player_id, 2);
    assert.equal(db.state.game.current_player_id, 2);
    assert.equal(db.state.game.game_status, 'completed');
});

test('bank takes properties and splits remaining cash evenly for a pay-each-player debt', async () => {
    const db = createFakeDatabase({
        players: [
            player(1, 'Debtor', 101),
            player(2, 'Player Two', 100),
            player(3, 'Player Three', 200)
        ],
        properties: [
            {
                property_id: 11,
                property_name: 'Another Street',
                price: 50,
                house_cost: 25,
                hotel_cost: 100
            }
        ],
        ownership: [
            {
                player_id: 1,
                property_id: 11,
                houses: 0,
                hotels: 0,
                mortgaged: 0
            }
        ],
        game: game()
    });

    const result = await declareBankruptcyAsync(
        db,
        1,
        1,
        null,
        500,
        { splitCashAmongPlayers: true }
    );

    assert.equal(result.splitCashAmongPlayers, true);
    assert.equal(result.creditorName, 'the bank');
    assert.deepEqual(
        result.cashRecipients.map(recipient => recipient.amount),
        [51, 50]
    );
    assert.equal(result.unpaidDebt, 399);
    assert.equal(db.state.players[0].is_bankrupt, 1);
    assert.equal(db.state.players[1].money, 151);
    assert.equal(db.state.players[2].money, 250);
    assert.equal(db.state.ownership.length, 0);
    assert.equal(db.state.game.current_player_id, 2);
    assert.equal(db.state.game.game_status, 'in_progress');
});

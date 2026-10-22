const BOARD_SIZE = 40;
const GO_POSITION = 0;

function rollDice() {
    const die1 = Math.floor(Math.random() * 6) + 1;
    const die2 = Math.floor(Math.random() * 6) + 1;

    return {
        die1,
        die2,
        total: die1 + die2
    };
}

function calculateNewPosition(currentPosition, diceTotal) {
    if (
        !Number.isInteger(currentPosition) ||
        currentPosition < 0 ||
        currentPosition >= BOARD_SIZE
    ) {
        throw new Error('Invalid player position.');
    }

    if (
        !Number.isInteger(diceTotal) ||
        diceTotal < 2 ||
        diceTotal > 12
    ) {
        throw new Error('Invalid dice total.');
    }

    return (currentPosition + diceTotal) % BOARD_SIZE;
}

module.exports = {
    BOARD_SIZE,
    GO_POSITION,
    rollDice,
    calculateNewPosition
};
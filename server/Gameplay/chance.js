const chanceCards = [
    { id: 'advance-go', type: 'move_to', position: 0, collectGo: true },
    { id: 'advance-boardwalk', type: 'move_to', position: 39 },
    { id: 'advance-gump-grove', type: 'move_to', position: 31 },
    { id: 'nearest-railroad', type: 'move_to_nearest', target: 'railroad', rentMultiplier: 2 },
    { id: 'nearest-utility', type: 'move_to_nearest', target: 'utility', rentMultiplier: 10 },
    { id: 'bank-dividend', type: 'collect', amount: 50 },
    { id: 'speeding-fine', type: 'pay', amount: 15 },
    { id: 'building-loan', type: 'collect', amount: 150 },
    { id: 'chairman-fee', type: 'pay_each_player', amount: 50 },
    { id: 'birthday-collection', type: 'collect_each_player', amount: 50 },
    { id: 'repairs', type: 'pay_repairs', houseCost: 25, hotelCost: 100 },
    { id: 'go-back-three', type: 'move_relative', spaces: -3 },
    { id: 'go-to-jail', type: 'go_to_jail' },
    { id: 'jail-free', type: 'get_out_of_jail_free' },
    { id: 'advance-nearest-railroad', type: 'move_to_nearest', target: 'railroad', rentMultiplier: 2 },
    { id: 'general-repairs', type: 'pay_repairs', houseCost: 40, hotelCost: 115 }
];

module.exports = chanceCards;
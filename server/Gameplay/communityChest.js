const communityChestCards = [
    { id: 'advance-go', type: 'move_to', position: 0, collectGo: true },
    { id: 'bank-error', type: 'collect', amount: 200 },
    { id: 'doctor-fee', type: 'pay', amount: 50 },
    { id: 'stock-sale', type: 'collect', amount: 50 },
    { id: 'jail-free', type: 'get_out_of_jail_free' },
    { id: 'go-to-jail', type: 'go_to_jail' },
    { id: 'holiday-fund', type: 'collect', amount: 100 },
    { id: 'income-tax-refund', type: 'collect', amount: 20 },
    { id: 'birthday', type: 'collect_each_player', amount: 10 },
    { id: 'life-insurance', type: 'collect', amount: 100 },
    { id: 'hospital-fees', type: 'pay', amount: 100 },
    { id: 'school-fees', type: 'pay', amount: 50 },
    { id: 'consultancy-fee', type: 'collect', amount: 25 },
    { id: 'street-repairs', type: 'pay_repairs', houseCost: 40, hotelCost: 115 },
    { id: 'beauty-contest', type: 'collect', amount: 10 },
    { id: 'inheritance', type: 'collect', amount: 100 }
];

module.exports = communityChestCards;
UPDATE Property
SET hotel_cost = house_cost * 4
WHERE board_position IN (
    1, 3, 6, 8, 9,
    11, 13, 14, 16, 18, 19,
    21, 23, 24, 26, 27, 29,
    31, 32, 34, 37, 39
);

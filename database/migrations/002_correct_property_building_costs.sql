UPDATE Property
SET house_cost = 50, hotel_cost = 200
WHERE board_position IN (1, 3, 6, 8, 9);

UPDATE Property
SET house_cost = 100, hotel_cost = 400
WHERE board_position IN (11, 13, 14, 16, 18, 19);

UPDATE Property
SET house_cost = 150, hotel_cost = 600
WHERE board_position IN (21, 23, 24, 26, 27, 29);

UPDATE Property
SET house_cost = 200, hotel_cost = 800
WHERE board_position IN (31, 32, 34, 37, 39);

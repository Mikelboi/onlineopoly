ALTER TABLE `onlineopoly`.`Game`
ADD COLUMN `game_mode` VARCHAR(12) NOT NULL DEFAULT 'online';

ALTER TABLE `onlineopoly`.`Player`
DROP INDEX `user_game_UNIQUE`;

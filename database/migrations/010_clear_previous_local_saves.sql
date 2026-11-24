UPDATE `onlineopoly`.`Game`
SET `is_saved` = 0,
    `saved_at` = NULL
WHERE `game_mode` = 'local';

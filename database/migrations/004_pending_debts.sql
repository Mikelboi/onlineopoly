CREATE TABLE IF NOT EXISTS `onlineopoly`.`Pending_Debt` (
  `pending_debt_id` INT NOT NULL AUTO_INCREMENT,
  `game_id` INT NOT NULL,
  `debtor_player_id` INT NOT NULL,
  `creditor_player_id` INT NULL,
  `amount_due` DECIMAL(10,2) NOT NULL,
  `debt_source` VARCHAR(45) NOT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`pending_debt_id`),
  INDEX `idx_pending_debt_game_debtor` (`game_id`, `debtor_player_id`),
  CONSTRAINT `fk_Pending_Debt_Debtor`
    FOREIGN KEY (`debtor_player_id`, `game_id`)
    REFERENCES `onlineopoly`.`Player` (`player_id`, `game_id`)
    ON DELETE NO ACTION
    ON UPDATE NO ACTION,
  CONSTRAINT `fk_Pending_Debt_Creditor`
    FOREIGN KEY (`creditor_player_id`, `game_id`)
    REFERENCES `onlineopoly`.`Player` (`player_id`, `game_id`)
    ON DELETE NO ACTION
    ON UPDATE NO ACTION
) ENGINE = InnoDB;
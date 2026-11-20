CREATE TABLE IF NOT EXISTS `onlineopoly`.`Trade_Offer` (
  `trade_id` INT NOT NULL AUTO_INCREMENT,
  `game_id` INT NOT NULL,
  `offering_player_id` INT NOT NULL,
  `receiving_player_id` INT NOT NULL,
  `offering_cash` DECIMAL(10,2) NOT NULL DEFAULT 0,
  `receiving_cash` DECIMAL(10,2) NOT NULL DEFAULT 0,
  `status` VARCHAR(20) NOT NULL DEFAULT 'pending',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`trade_id`),
  UNIQUE INDEX `trade_offer_id_game_UNIQUE` (`trade_id`, `game_id`),
  INDEX `idx_trade_offer_receiving_status`
    (`game_id`, `receiving_player_id`, `status`),
  CONSTRAINT `fk_Trade_Offer_Game`
    FOREIGN KEY (`game_id`)
    REFERENCES `onlineopoly`.`Game` (`game_id`)
    ON DELETE NO ACTION
    ON UPDATE NO ACTION,
  CONSTRAINT `fk_Trade_Offer_Offering_Player`
    FOREIGN KEY (`offering_player_id`, `game_id`)
    REFERENCES `onlineopoly`.`Player` (`player_id`, `game_id`)
    ON DELETE NO ACTION
    ON UPDATE NO ACTION,
  CONSTRAINT `fk_Trade_Offer_Receiving_Player`
    FOREIGN KEY (`receiving_player_id`, `game_id`)
    REFERENCES `onlineopoly`.`Player` (`player_id`, `game_id`)
    ON DELETE NO ACTION
    ON UPDATE NO ACTION
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS `onlineopoly`.`Trade_Offer_Property` (
  `trade_id` INT NOT NULL,
  `game_id` INT NOT NULL,
  `property_id` INT NOT NULL,
  `property_giver_player_id` INT NOT NULL,
  PRIMARY KEY (`trade_id`, `property_id`),
  INDEX `idx_trade_offer_property_game_giver`
    (`game_id`, `property_giver_player_id`),
  CONSTRAINT `fk_Trade_Offer_Property_Trade`
    FOREIGN KEY (`trade_id`, `game_id`)
    REFERENCES `onlineopoly`.`Trade_Offer` (`trade_id`, `game_id`)
    ON DELETE CASCADE
    ON UPDATE NO ACTION,
  CONSTRAINT `fk_Trade_Offer_Property_Property`
    FOREIGN KEY (`property_id`)
    REFERENCES `onlineopoly`.`Property` (`property_id`)
    ON DELETE NO ACTION
    ON UPDATE NO ACTION,
  CONSTRAINT `fk_Trade_Offer_Property_Giver`
    FOREIGN KEY (`property_giver_player_id`, `game_id`)
    REFERENCES `onlineopoly`.`Player` (`player_id`, `game_id`)
    ON DELETE NO ACTION
    ON UPDATE NO ACTION
) ENGINE = InnoDB;
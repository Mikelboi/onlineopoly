
SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0;
SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0;
SET @OLD_SQL_MODE=@@SQL_MODE,
    SQL_MODE='ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';

-- Schema onlineopoly
CREATE SCHEMA IF NOT EXISTS `onlineopoly` DEFAULT CHARACTER SET utf8;
USE `onlineopoly`;

-- Table User
CREATE TABLE IF NOT EXISTS `onlineopoly`.`User` (
  `user_id` INT NOT NULL AUTO_INCREMENT,
  `username` VARCHAR(60) NOT NULL,
  `password` VARCHAR(60) NOT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`user_id`),
  UNIQUE INDEX `username_UNIQUE` (`username` ASC) VISIBLE
) ENGINE = InnoDB;

-- Table Game
CREATE TABLE IF NOT EXISTS `onlineopoly`.`Game` (
  `game_id` INT NOT NULL AUTO_INCREMENT,
  `game_status` VARCHAR(60) NOT NULL DEFAULT 'waiting',
  `player_count` INT NOT NULL DEFAULT 0,
  `gamestarted_at` DATETIME NULL DEFAULT NULL,
  PRIMARY KEY (`game_id`)
) ENGINE = InnoDB;

-- Table Player
CREATE TABLE IF NOT EXISTS `onlineopoly`.`Player` (
  `player_id` INT NOT NULL AUTO_INCREMENT,
  `player_name` VARCHAR(45) NOT NULL,
  `money` DECIMAL(10,2) NOT NULL DEFAULT 1500.00,
  `position` INT NOT NULL DEFAULT 0,
  `is_in_jail` TINYINT NOT NULL DEFAULT 0,
  `jail_free_cards` INT NOT NULL DEFAULT 0,
  `jail_turns` TINYINT NOT NULL DEFAULT 0,
  `is_bankrupt` TINYINT NOT NULL DEFAULT 0,
  `user_id` INT NOT NULL,
  `game_id` INT NOT NULL,
  PRIMARY KEY (`player_id`),
  UNIQUE INDEX `user_game_UNIQUE` (`user_id` ASC, `game_id` ASC),
  UNIQUE INDEX `player_game_pair_UNIQUE` (`player_id` ASC, `game_id` ASC),
  INDEX `fk_Player_User1_idx` (`user_id` ASC) VISIBLE,
  INDEX `fk_Player_Game1_idx` (`game_id` ASC) VISIBLE,
  CONSTRAINT `fk_Player_User1`
    FOREIGN KEY (`user_id`)
    REFERENCES `onlineopoly`.`User` (`user_id`)
    ON DELETE NO ACTION
    ON UPDATE NO ACTION,
  CONSTRAINT `fk_Player_Game1`
    FOREIGN KEY (`game_id`)
    REFERENCES `onlineopoly`.`Game` (`game_id`)
    ON DELETE NO ACTION
    ON UPDATE NO ACTION
) ENGINE = InnoDB;

-- Table Property
CREATE TABLE IF NOT EXISTS `onlineopoly`.`Property` (
  `property_id` INT NOT NULL AUTO_INCREMENT,
  `property_name` VARCHAR(45) NOT NULL,
  `board_position` INT NOT NULL,
  `property_type` VARCHAR(45) NOT NULL,
  `price` DECIMAL(10,2) NOT NULL,
  `rent` DECIMAL(10,2) NOT NULL,
  `color_group` VARCHAR(45) NOT NULL,
  `house_cost` DECIMAL(10,2) DEFAULT NULL,
  `hotel_cost` DECIMAL(10,2) DEFAULT NULL,
  UNIQUE INDEX `property_name_UNIQUE` (`property_name` ASC) VISIBLE,
  UNIQUE INDEX `property_board_position_UNIQUE` (`board_position` ASC) VISIBLE,
  PRIMARY KEY (`property_id`)
) ENGINE = InnoDB;

-- Table Player_Property
CREATE TABLE IF NOT EXISTS `onlineopoly`.`Player_Property` (
  `houses` INT NOT NULL DEFAULT 0,
  `hotels` INT NOT NULL DEFAULT 0,
  `mortgaged` TINYINT NOT NULL DEFAULT 0,
  `player_id` INT NOT NULL,
  `property_id` INT NOT NULL,
  PRIMARY KEY (`player_id`, `property_id`),
  INDEX `fk_Player_Property_Property1_idx` (`property_id` ASC) VISIBLE,
  CONSTRAINT `fk_Player_Property_Player1`
    FOREIGN KEY (`player_id`)
    REFERENCES `onlineopoly`.`Player` (`player_id`)
    ON DELETE NO ACTION
    ON UPDATE NO ACTION,
  CONSTRAINT `fk_Player_Property_Property1`
    FOREIGN KEY (`property_id`)
    REFERENCES `onlineopoly`.`Property` (`property_id`)
    ON DELETE NO ACTION
    ON UPDATE NO ACTION
) ENGINE = InnoDB;

-- Table Game_Transaction
CREATE TABLE IF NOT EXISTS `onlineopoly`.`Game_Transaction` (
  `transaction_id` INT NOT NULL AUTO_INCREMENT,
  `game_id` INT NOT NULL,
  `amount` DECIMAL(10,2) NOT NULL,
  `transaction_type` VARCHAR(45) NOT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `player_id` INT NOT NULL,
  PRIMARY KEY (`transaction_id`),
  INDEX `fk_Game_Transaction_Player_Game_idx` (`player_id` ASC, `game_id` ASC) VISIBLE,
  CONSTRAINT `fk_Game_Transaction_Player_Game`
    FOREIGN KEY (`player_id`, `game_id`)
    REFERENCES `onlineopoly`.`Player` (`player_id`, `game_id`)
    ON DELETE NO ACTION
    ON UPDATE NO ACTION
) ENGINE = InnoDB;

SET SQL_MODE=@OLD_SQL_MODE;
SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS;
SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS;

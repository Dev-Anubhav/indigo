'use strict';

const { createLogger, format, transports } = require('winston');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const LOG_PATH = process.env.LOG_PATH || './logs/scraper.log';
const logDir = path.dirname(path.resolve(LOG_PATH));
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

const logger = createLogger({
  level: 'info',
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.errors({ stack: true }),
    format.printf(({ timestamp, level, message, stack }) => {
      return stack
        ? `[${timestamp}] ${level.toUpperCase()}: ${message}\n${stack}`
        : `[${timestamp}] ${level.toUpperCase()}: ${message}`;
    })
  ),
  transports: [
    new transports.File({ filename: path.resolve(LOG_PATH), maxsize: 10 * 1024 * 1024, maxFiles: 3 }),
    new transports.Console({
      format: format.combine(
        format.colorize(),
        format.printf(({ level, message }) => `${level}: ${message}`)
      )
    })
  ]
});

module.exports = logger;

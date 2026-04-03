'use strict';

require('dotenv').config();
const db    = require('./db');
const chalk = require('chalk');

const count = db.resetFailedToPending();
console.log(chalk.green(`\n✅ Reset ${count} failed jobs back to pending.\n`));
console.log(chalk.cyan('Run "npm start" to retry them.\n'));

'use strict';

const airline = String(process.env.AIRLINE || "indigo").toLowerCase();

if (airline === "airindiaexpress") {
  module.exports = require("./airlines/airindiaexpress/scraper");
} else {
  module.exports = require("./airlines/indigo/scraper");
}

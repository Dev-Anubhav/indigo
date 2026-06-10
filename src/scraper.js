'use strict';

const airline = String(process.env.AIRLINE || "indigo").toLowerCase();

if (airline === "airindiaexpress") {
  module.exports = require("./airlines/airindiaexpress/scraper");
} else if (airline === "spicejet") {
  module.exports = require("./airlines/spicejet/scraper");
} else if (airline === "akasaair") {
  module.exports = require("./airlines/akasaair/scraper");
} else {
  module.exports = require("./airlines/indigo/scraper");
}

"use strict";

const { spawn } = require("child_process");
const path = require("path");

async function fetchRefund(pnr, lastName) {
  return new Promise((resolve, reject) => {
    const pythonScript = path.join(__dirname, "refundScraper.py");
    // spawn the python process
    // note: using python3 as the executable name
    const pyProcess = spawn("python3", [pythonScript, pnr, lastName]);

    let output = "";
    let errorOutput = "";

    pyProcess.stdout.on("data", (data) => {
      output += data.toString();
    });

    pyProcess.stderr.on("data", (data) => {
      // we pipe stderr to the console so we can see the console logs from python
      process.stdout.write(data.toString());
      errorOutput += data.toString();
    });

    pyProcess.on("close", (code) => {
      if (code !== 0 && !output.trim()) {
        reject(new Error(`Python scraper exited with code ${code}. Error: ${errorOutput}`));
        return;
      }
      
      try {
        // extract the last valid JSON line
        const lines = output.trim().split("\n");
        let result = null;
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            result = JSON.parse(lines[i]);
            break;
          } catch (e) {
            // ignore malformed lines
          }
        }
        
        if (!result) {
          throw new Error("Could not parse JSON output from Python script.");
        }
        
        if (!result.success) {
          reject(new Error(result.error || "Unknown python scraper error"));
        } else {
          resolve(result);
        }
      } catch (err) {
        reject(new Error(`JSON Parse Error: ${err.message}. Output was: ${output}`));
      }
    });
  });
}

async function closeBrowser() {
  // since python handles the browser per invocation, there's no persistent browser to close here
  console.log("[Node] closeBrowser called - handled natively by Python scraper.");
  return Promise.resolve();
}

module.exports = {
  fetchRefund,
  closeBrowser,
};

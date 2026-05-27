const crypto = require('crypto');
const secretSalt = 'indigo-extractor-ultimate-salt-2026';

function generateLicenseKey(machineId) {
    // Generate a secure, deterministic key based on the machine ID and our secret
    const hash = crypto.createHmac('sha256', secretSalt)
                       .update(machineId.trim())
                       .digest('hex');
    
    // Format it to look like a standard software key: IND-AAAA-BBBB-CCCC-DDDD
    const prefix = 'IND';
    const p1 = hash.substring(0, 4).toUpperCase();
    const p2 = hash.substring(4, 8).toUpperCase();
    const p3 = hash.substring(8, 12).toUpperCase();
    const p4 = hash.substring(12, 16).toUpperCase();
    
    return `${prefix}-${p1}-${p2}-${p3}-${p4}`;
}

const args = process.argv.slice(2);
if (args.length === 0) {
    console.log('❌ Error: Please provide a Machine ID.');
    console.log('ℹ️ Usage: node keygen.js [MACHINE_ID]');
    process.exit(1);
}

const clientMachineId = args[0];
const licenseKey = generateLicenseKey(clientMachineId);

console.log('\n=========================================');
console.log('✅ IndiGo Scraper - License Keygen');
console.log('=========================================');
console.log(`Client Machine ID : ${clientMachineId}`);
console.log(`License Key       : ${licenseKey}`);
console.log('=========================================\n');
console.log('Give the License Key to the client so they can activate the app.');

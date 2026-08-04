const fs = require('fs');
const path = require('path');

const required = [
  'test/test-ws-auth.js',
  // Add other required test files here if needed
];

let missing = [];
for (const f of required) {
  if (!fs.existsSync(path.join(__dirname, '..', f))) {
    missing.push(f);
  }
}

if (missing.length > 0) {
  console.error('Missing required test files:\n' + missing.map((m) => `  - ${m}`).join('\n'));
  process.exit(2);
}

console.log('All required test files present.');

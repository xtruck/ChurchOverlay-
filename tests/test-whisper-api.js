/**
 * Test direct de l'API whisper-server
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const testFile = path.join(__dirname, 'temp-audio', 'test-silence.wav');

console.log('Test de l\'API whisper-server avec:', testFile);

// Test 1: POST avec form-data
const formData = require('form-data');
const form = new formData();
form.append('file', fs.createReadStream(testFile));   // <-- changed from 'audio' to 'file'

const req = http.request({
  hostname: '127.0.0.1',
  port: 8080,
  path: '/inference',
  method: 'POST',
  headers: form.getHeaders(),
});

form.pipe(req);

req.on('response', (res) => {
  console.log('Status:', res.statusCode);
  console.log('Headers:', res.headers);
  
  let data = '';
  res.on('data', (chunk) => data += chunk);
  res.on('end', () => {
    console.log('Response:', data);
    process.exit(0);
  });
});

req.on('error', (err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
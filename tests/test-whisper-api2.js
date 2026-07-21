/**
 * Test différents formats de requête pour whisper-server
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const testFile = path.join(__dirname, 'temp-audio', 'test-silence.wav');

console.log('Test différents formats de requête...');

// Test 1: POST avec Content-Type: audio/wav
const audioBuffer = fs.readFileSync(testFile);

const req1 = http.request({
  hostname: '127.0.0.1',
  port: 8080,
  path: '/inference',
  method: 'POST',
  headers: {
    'Content-Type': 'audio/wav',
    'Content-Length': audioBuffer.length,
  },
});

req1.write(audioBuffer);
req1.end();

req1.on('response', (res) => {
  console.log('Test 1 - Status:', res.statusCode);
  let data = '';
  res.on('data', (chunk) => data += chunk);
  res.on('end', () => {
    console.log('Test 1 - Response:', data);
    
    // Test 2: POST avec fichier via multipart
    const formData = require('form-data');
    const form = new formData();
    form.append('file', fs.createReadStream(testFile));
    
    const req2 = http.request({
      hostname: '127.0.0.1',
      port: 8080,
      path: '/inference',
      method: 'POST',
      headers: form.getHeaders(),
    });
    
    form.pipe(req2);
    
    req2.on('response', (res2) => {
      console.log('Test 2 - Status:', res2.statusCode);
      let data2 = '';
      res2.on('data', (chunk) => data2 += chunk);
      res2.on('end', () => {
        console.log('Test 2 - Response:', data2);
        process.exit(0);
      });
    });
    
    req2.on('error', (err) => {
      console.error('Test 2 - Error:', err.message);
      process.exit(1);
    });
  });
});

req1.on('error', (err) => {
  console.error('Test 1 - Error:', err.message);
  process.exit(1);
});

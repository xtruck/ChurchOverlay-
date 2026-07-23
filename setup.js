/**
 * ============================================================================
 *  setup.js — Script de configuration interactive
 * ----------------------------------------------------------------------------
 *  Aide à la configuration initiale du système xtruck
 * ============================================================================
 */

const readline = require('readline');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

function executeCommand(command) {
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else {
        resolve(stdout);
      }
    });
  });
}

async function checkFFmpeg() {
  console.log('\n🔍 Vérification de FFmpeg...');
  try {
    await executeCommand('ffmpeg -version');
    console.log('✅ FFmpeg est installé');
    return true;
  } catch (error) {
    console.log('❌ FFmpeg n\'est pas installé');
    console.log('📥 Téléchargez FFmpeg depuis https://ffmpeg.org/download.html');
    return false;
  }
}

async function listAudioDevices() {
  console.log('\n🎤 Liste des périphériques audio...');
  try {
    await executeCommand('node list-audio-devices.js');
  } catch (error) {
    console.log('⚠️ Impossible de lister les périphériques audio');
  }
}

async function checkDependencies() {
  console.log('\n📦 Vérification des dépendances Node.js...');
  
  if (!fs.existsSync('node_modules')) {
    console.log('📥 Installation des dépendances...');
    try {
      await executeCommand('npm install');
      console.log('✅ Dépendances installées');
    } catch (error) {
      console.log('❌ Erreur lors de l\'installation des dépendances');
      return false;
    }
  } else {
    console.log('✅ Dépendances déjà installées');
  }
  
  return true;
}

async function checkWhisperFiles() {
  console.log('\n🤖 Vérification des fichiers Whisper...');
  
  const whisperServer = path.join('whisper', 'whisper-server.exe');
  const modelPath = path.join('whisper', 'models', 'ggml-tiny.bin');
  const modelBasePath = path.join('whisper', 'models', 'ggml-base.bin');
  
  let hasServer = fs.existsSync(whisperServer);
  let hasModel = fs.existsSync(modelPath) || fs.existsSync(modelBasePath);
  
  if (hasServer) {
    console.log('✅ whisper-server.exe trouvé');
  } else {
    console.log('❌ whisper-server.exe non trouvé');
  }
  
  if (hasModel) {
    console.log('✅ Modèle Whisper trouvé');
  } else {
    console.log('❌ Modèle Whisper non trouvé');
  }
  
  return hasServer && hasModel;
}

async function createEnvFile() {
  console.log('\n⚙️ Configuration des variables d\'environnement...');
  
  const port = await question('Port du serveur (8765): ') || '8765';
  const audioDevice = await question('Nom du périphérique audio (laisser vide pour mode manuel): ');
  const ffmpegPath = await question('Chemin FFmpeg (laisser vide si dans PATH): ');
  const nodeEnv = await question('Environnement (development/production) [development]: ') || 'development';
  
  let envContent = `PORT=${port}\n`;
  if (audioDevice) envContent += `AUDIO_DEVICE=${audioDevice}\n`;
  if (ffmpegPath) envContent += `FFMPEG_PATH=${ffmpegPath}\n`;
  envContent += `NODE_ENV=${nodeEnv}\n`;
  
  fs.writeFileSync('.env', envContent);
  console.log('✅ Fichier .env créé');
  
  return { port, audioDevice, ffmpegPath, nodeEnv };
}

async function createStartupScript() {
  console.log('\n📜 Création du script de démarrage...');
  
  const scriptContent = `@echo off
echo Démarrage de xtruck Church Overlay...
call .env
node server.js
pause
`;
  
  fs.writeFileSync('start.bat', scriptContent);
  console.log('✅ Script start.bat créé');
}

async function createPowerShellScript() {
  console.log('\n📜 Création du script PowerShell...');
  
  const scriptContent = `# Script de démarrage pour xtruck Church Overlay
Write-Host "Démarrage de xtruck Church Overlay..." -ForegroundColor Green

# Charger les variables d'environnement
if (Test-Path .env) {
    Get-Content .env | ForEach-Object {
        if ($_ -match '^([^=]+)=(.*)$') {
            [Environment]::SetEnvironmentVariable($matches[1], $matches[2])
        }
    }
}

Write-Host "Configuration chargée" -ForegroundColor Yellow
node server.js
`;
  
  fs.writeFileSync('start.ps1', scriptContent);
  console.log('✅ Script start.ps1 créé');
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║      Configuration de xtruck Church Overlay              ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  
  try {
    // Vérifications
    const depsOk = await checkDependencies();
    const ffmpegOk = await checkFFmpeg();
    const whisperOk = await checkWhisperFiles();
    
    if (!ffmpegOk) {
      console.log('\n⚠️ FFmpeg est requis pour la capture audio');
      console.log('Le système fonctionnera en mode manuel sans FFmpeg');
    }
    
    if (!whisperOk) {
      console.log('\n⚠️ Les fichiers Whisper sont requis pour la transcription');
      console.log('Le système fonctionnera en mode manuel sans Whisper');
    }
    
    // Configuration audio
    if (ffmpegOk) {
      await listAudioDevices();
      const configureAudio = await question('\nVoulez-vous configurer le micro maintenant? (o/n): ');
      if (configureAudio.toLowerCase() === 'o') {
        await createEnvFile();
      }
    }
    
    // Scripts de démarrage
    const createScripts = await question('\nVoulez-vous créer les scripts de démarrage? (o/n): ');
    if (createScripts.toLowerCase() === 'o') {
      await createStartupScript();
      await createPowerShellScript();
    }
    
    // Résumé
    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║                   Configuration terminée                   ║');
    console.log('╚══════════════════════════════════════════════════════════╝');
    
    console.log('\n📋 Prochaines étapes:');
    console.log('1. Configurez OBS Studio avec overlay.html');
    console.log('2. Lancez le serveur: npm start');
    console.log('3. Testez avec: node tests/test-envoi.js');
    
    if (fs.existsSync('start.bat')) {
      console.log('4. Ou utilisez: start.bat');
    }
    
    console.log('\n📚 Documentation:');
    console.log('- Guide de déploiement: DEPLOYMENT_GUIDE.md');
    console.log('- API WebSocket: API.md');
    console.log('- Architecture: ARCHITECTURE.md');
    
  } catch (error) {
    console.error('\n❌ Erreur lors de la configuration:', error.message);
  } finally {
    rl.close();
  }
}

main();
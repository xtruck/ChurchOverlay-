@echo off
REM ============================================================================
REM  install-dependencies.bat - One-time setup for Church Overlay
REM ============================================================================
REM  Run this ONCE before using start-server.bat
REM  This installs Node.js dependencies and verifies your setup
REM ============================================================================

echo.
echo ============================================================================
echo   Church Overlay - Dependency Installation
echo ============================================================================
echo.

REM Check if Node.js is installed
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found!
    echo.
    echo Please download and install Node.js from:
    echo   https://nodejs.org/
    echo.
    echo After installation, run this script again.
    echo.
    pause
    exit /b 1
)

echo [OK] Node.js found: 
node --version
echo.

REM Check if npm is available
where npm >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] npm not found!
    echo NPM should come with Node.js. Try reinstalling Node.js.
    echo.
    pause
    exit /b 1
)

echo [OK] npm found:
npm --version
echo.

REM NOTE (v0.5.0) : FFmpeg n'est plus une dependance. La capture micro
REM utilise desormais getUserMedia (Web Audio) dans la fenetre Electron
REM cachee de l'app (voir capture.html / audio-capture.js). Elle ne
REM fonctionne QUE dans l'app Electron packagee (npm start), pas via
REM "node server.js" en standalone : ce mode n'a pas de contexte Chromium
REM pour appeler getUserMedia et la capture audio y restera indisponible.

REM Install Node.js dependencies
echo Installing Node.js dependencies...
echo.
call npm install

if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Failed to install dependencies!
    echo Please check the error messages above.
    echo.
    pause
    exit /b 1
)

echo.
echo [OK] Dependencies installed successfully!
echo.

REM Create .env if it doesn't exist
if not exist ".env" (
    echo Creating .env configuration file...
    copy ".env.example" ".env" >nul
    echo [OK] .env created
    echo.
    echo NEXT STEPS:
    echo.
    echo 1. Run the app with: npm start
    echo    - The microphone is now chosen from the on-screen setup
    echo      window (first run), not from a command-line tool.
    echo.
    echo 2. Optional: Get Groq API key for better accuracy
    echo    - Go to: https://console.groq.com/keys
    echo    - Add to .env: GROQ_API_KEY=your_key_here
    echo.
    echo 3. Audio capture only works via "npm start" (the Electron app).
    echo    start-server.bat / "node server.js" run the server without
    echo    a microphone.
    echo.
) else (
    echo [OK] .env already exists
)

echo.
echo ============================================================================
echo   Setup Complete!
echo ============================================================================
echo.
echo You can now run: start-server.bat
echo.
pause

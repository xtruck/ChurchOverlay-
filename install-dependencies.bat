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

REM Check if FFmpeg is installed
where ffmpeg >nul 2>nul
if %errorlevel% equ 0 (
    echo [OK] FFmpeg found:
    ffmpeg -version | findstr /B "ffmpeg version"
    echo.
) else (
    echo [WARNING] FFmpeg not found in PATH
    echo.
    echo FFmpeg is needed for audio capture. Download from:
    echo   https://ffmpeg.org/download.html
    echo.
    echo You can still use the server for manual verse entry,
    echo but automatic audio capture will not work.
    echo.
    set /p CONTINUE="Continue anyway? (y/n): "
    if /i not "%CONTINUE%"=="y" (
        exit /b 1
    )
    echo.
)

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
    echo 1. Edit the .env file (open it with Notepad):
    echo    - Find your microphone name:
    echo      node list-audio-devices.js
    echo    - Update AUDIO_DEVICE in .env with the exact name
    echo.
    echo 2. Optional: Get Groq API key for better accuracy
    echo    - Go to: https://console.groq.com/keys
    echo    - Add to .env: GROQ_API_KEY=your_key_here
    echo.
    echo 3. Run start-server.bat to start the server
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

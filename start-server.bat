@echo off
REM ============================================================================
REM  start-server.bat - One-click server startup for Church Overlay
REM ============================================================================
REM  This script starts the WebSocket server automatically with minimal setup.
REM  Simply double-click this file to start!
REM
REM  Prerequisites (should already be installed):
REM    - Node.js 16+
REM
REM  IMPORTANT (v0.5.0): audio capture uses getUserMedia inside the
REM  Electron app and needs a Chromium window to work. This script starts
REM  server.js standalone (no Electron window), so the pipeline will run
REM  but WITHOUT microphone capture. To get automatic verse detection
REM  from the microphone, run the packaged app instead: npm start
REM
REM  Configuration:
REM    - Edit .env file to set your microphone and other settings
REM    - First time? Run install-dependencies.bat first
REM ============================================================================

echo.
echo ============================================================================
echo   Church Overlay - WebSocket Server Startup
echo ============================================================================
echo.

REM Check if Node.js is installed
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found!
    echo.
    echo Please install Node.js from: https://nodejs.org/
    echo Then restart this script.
    echo.
    pause
    exit /b 1
)

echo [OK] Node.js found

REM Check if .env exists, if not copy from .env.example
if not exist ".env" (
    echo.
    echo [WARNING] .env not found. Creating from .env.example...
    if exist ".env.example" (
        copy ".env.example" ".env" >nul
        echo [OK] .env created
        echo.
        echo Next steps:
        echo 1. For automatic microphone capture, use: npm start
        echo    (the microphone is picked from the setup window, not .env)
        echo 2. This script (server.js standalone) runs without a microphone
        echo.
        pause
        exit /b 0
    ) else (
        echo [ERROR] .env.example not found!
        pause
        exit /b 1
    )
)

echo [OK] .env configuration found
echo.

REM Check if node_modules exists
if not exist "node_modules" (
    echo [WARNING] Dependencies not installed. Installing...
    call npm install
    if %errorlevel% neq 0 (
        echo [ERROR] Failed to install dependencies
        pause
        exit /b 1
    )
    echo [OK] Dependencies installed
)

echo [OK] Dependencies ready
echo.
echo ============================================================================
echo   Starting Church Overlay Server...
echo ============================================================================
echo.
echo Server will run on: ws://127.0.0.1:8765
echo
echo In OBS, create a Browser Source with URL:
echo   file:///C:/path/to/xtruck/overlay.html
echo
echo Press Ctrl+C to stop the server
echo.
echo ============================================================================
echo.

REM Start the server
node server.js

if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Server crashed!
    echo Please check the error messages above.
    echo.
    pause
)

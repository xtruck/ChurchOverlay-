@echo off
REM ============================================================================
REM  start-server.bat - One-click server startup for Church Overlay
REM ============================================================================
REM  This script starts the WebSocket server automatically with minimal setup.
REM  Simply double-click this file to start!
REM
REM  Prerequisites (should already be installed):
REM    - Node.js 16+ 
REM    - FFmpeg (in PATH)
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
        echo [OK] .env created - please edit it with your microphone name
        echo.
        echo Next steps:
        echo 1. Run: node list-audio-devices.js (to find your microphone)
        echo 2. Edit .env and set AUDIO_DEVICE to your microphone name
        echo 3. Run this script again
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

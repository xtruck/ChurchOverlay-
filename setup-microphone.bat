@echo off
REM ============================================================================
REM  setup-microphone.bat - Find and configure your microphone
REM ============================================================================

echo.
echo ============================================================================
echo   Church Overlay - Microphone Setup
echo ============================================================================
echo.
echo Available audio devices:
echo.

REM Run the device lister
node list-audio-devices.js

if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Could not list audio devices!
    echo.
    echo Make sure you've run install-dependencies.bat first.
    echo.
    pause
    exit /b 1
)

echo.
echo ============================================================================
echo.
echo Now edit the .env file:
echo.
echo 1. Open: .env (use Notepad or any text editor)
echo 2. Find: AUDIO_DEVICE=
echo 3. Replace the value with your microphone name (copy from list above)
echo 4. Save the file
echo.
echo Example:
echo   AUDIO_DEVICE=Microphone (High Definition Audio Device)
echo.
echo ============================================================================
echo.
pause

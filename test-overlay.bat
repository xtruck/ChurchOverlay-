@echo off
REM ============================================================================
REM  test-overlay.bat - Quick test of the overlay without microphone
REM ============================================================================

echo.
echo ============================================================================
echo   Church Overlay - Test Mode
echo ============================================================================
echo.
echo This will send a test verse to the overlay.
echo.
echo Make sure:
echo   1. start-server.bat is running (keep it open)
echo   2. OBS is open with the Bible Overlay source
echo.

echo Starting test...
echo.

node tests/test-envoi.js

if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Test failed!
    echo.
    echo Make sure start-server.bat is running.
    echo.
)

echo.
pause

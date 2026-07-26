@echo off
REM ============================================================================
REM  setup-microphone.bat - Configure your microphone
REM ----------------------------------------------------------------------------
REM  CHANGELOG v0.5.0 : ce script appelait auparavant `node list-audio-devices.js`
REM  (backend FFmpeg/DirectShow), retire du projet. La liste des microphones
REM  et le choix du peripherique se font desormais directement dans
REM  l'application (fenetre de configuration au premier lancement, ou bouton
REM  "changer de microphone" dans le tableau de bord) via getUserMedia — la
REM  meme couche audio que Windows/Chromium. Il n'y a plus de nom de
REM  peripherique a copier/coller dans .env.
REM ============================================================================

echo.
echo ============================================================================
echo   Church Overlay - Microphone Setup
echo ============================================================================
echo.
echo The microphone is now selected from inside the app itself, not from
echo this script or the .env file.
echo.
echo 1. Run: npm start
echo 2. On first launch, a setup window opens and lists your microphones
echo    (the same list Windows Settings shows).
echo 3. Pick your microphone, then your Groq API key, and confirm.
echo 4. To change the microphone later, use the "Changer de micro" button
echo    in the ChurchOverlay dashboard window.
echo.
echo ============================================================================
echo.
pause

@echo off
setlocal

REM ============================================================================
REM  update-build.bat - Met a jour le code et reconstruit l'installeur Windows
REM ----------------------------------------------------------------------------
REM  USAGE : double-clique sur ce fichier depuis le dossier du projet.
REM  Il faut que ce fichier soit place a la racine du projet (a cote de
REM  package.json).
REM ============================================================================

cd /d "%~dp0"

echo ===============================================
echo   ChurchOverlay - Mise a jour et reconstruction
echo ===============================================
echo.

echo [1/4] Recuperation des derniers changements (git pull)...
git pull
if errorlevel 1 (
    echo.
    echo ERREUR : git pull a echoue. Verifie ta connexion et que le depot
    echo est bien configure ^(git remote -v^).
    pause
    exit /b 1
)
echo.

echo [2/4] Installation des dependances (npm install)...
call npm install
if errorlevel 1 (
    echo.
    echo ERREUR : npm install a echoue.
    pause
    exit /b 1
)
echo.

echo [3/4] Verification rapide (npm test)...
call npm test
if errorlevel 1 (
    echo.
    echo ATTENTION : des tests ont echoue. Le build va continuer, mais
    echo verifie ce qui a echoue ci-dessus avant de distribuer le .exe.
    echo.
)
echo.

echo [4/4] Construction de l'installeur (npm run dist)...
call npm run dist
if errorlevel 1 (
    echo.
    echo ERREUR : la construction a echoue.
    pause
    exit /b 1
)

echo.
echo ===============================================
echo   Termine ! Nouvel installeur disponible dans :
echo   dist\
echo ===============================================
echo.
dir /b "dist\*.exe"
echo.
pause

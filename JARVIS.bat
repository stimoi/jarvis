@echo off
rem Lance JARVIS (appli de bureau + serveur + agent PC). Double-clic pour démarrer.
cd /d "%~dp0"
if not exist node_modules (
  echo Installation des dependances...
  call npm install
)
if exist node_modules\electron (
  start "" /min cmd /c "npm run desktop"
) else (
  echo Electron absent : lancement en mode navigateur sur http://localhost:8787
  start "" http://localhost:8787
  call npm start
)

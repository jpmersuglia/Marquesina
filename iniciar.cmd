@echo off
cd /d "%~dp0"
title Marquesina
echo Iniciando servidor Marquesina en http://localhost:3333...
start http://localhost:3333
node server.js
pause

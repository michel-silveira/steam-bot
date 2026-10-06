@echo off
:start
node main.js
if %errorlevel%==2 goto end
echo Restarting in 5 seconds...
timeout /t 5 /nobreak >nul
goto start
:end

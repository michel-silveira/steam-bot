@echo off
npm install
if not exist config.json (
    copy config.example.json config.json >nul
    echo Created config.json - fill in your details before running run.bat
)

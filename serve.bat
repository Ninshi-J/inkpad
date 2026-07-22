@echo off
cd /d "%~dp0"
start http://localhost:18793/app.html
python -m http.server 18793 --bind 127.0.0.1

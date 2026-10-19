@echo off
cd /d "%~dp0"
REM ---- Panel (port 3000) ----
start "MC Panel" /min cmd /c "node server.js"
REM ---- Cloudflare Tunnel (cloud.roun.sryze.cc) — runtime\tunnel_token.txt thakle auto ----
setTUN=POLL
if exist "runtime\cloudflared.exe" if exist "runtime\tunnel_token.txt" (
  start "CF Tunnel" /min cmd /c "runtime\cloudflared.exe tunnel run --token-file runtime\tunnel_token.txt"
)
REM ---- Browser e khulo ----
timeout /t 2 /nobreak >nul
start http://localhost:3000/
echo Panel chalu: http://localhost:3000/  +  https://cloud.roun.sryze.cc
echo To stop: close both the "MC Panel" and "CF Tunnel" windows
pause

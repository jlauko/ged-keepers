@echo off
echo Starting GED Keepers servers...

REM --- Start frontend server ---
start "Frontend Server" cmd /k ^
    "cd /d C:\Users\Lauko\OneDrive - SRC Inc. (Syracuse Research)\Desktop\Personal\geneology\GED Keepers\frontend && python -m http.server 8000 --bind 0.0.0.0"

REM --- Start backend server ---
start "Backend Server" cmd /k ^
    "cd /d C:\Users\Lauko\OneDrive - SRC Inc. (Syracuse Research)\Desktop\Personal\geneology\GED Keepers\backend && node serverV1-1.js"

echo Both servers started.

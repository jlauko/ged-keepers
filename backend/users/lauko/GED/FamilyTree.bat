@echo off
setlocal
cd /d "%~dp0"

echo ===============================================
echo Updating Family Tree Data...
echo ===============================================
echo.

:: --- Ask for GED filename ---
set /p GEDFILE=Enter the name of the GED file (e.g. LaukoFamilyTree.ged):
echo.
echo You entered: %GEDFILE%
echo.

if not exist "%GEDFILE%" (
    echo ERROR: "%GEDFILE%" not found in this folder.
    pause
    exit /b 1
)

:: birthLocationColors.json is a hand-maintained palette the frontend needs;
:: no script generates it, so just check it's present.
if not exist "birthLocationColors.json" (
    echo ERROR: birthLocationColors.json is missing ^(hand-maintained config^).
    pause
    exit /b 1
)

echo [1/4] family_tree5.py  -^> family.json
python family_tree5.py --ged "%GEDFILE%"
if %errorlevel% neq 0 ( echo ERROR: family_tree5.py failed & pause & exit /b %errorlevel% )

echo [2/4] GEDtoPersonalEventsV2.py  -^> personalHistoryEvents.json
python GEDtoPersonalEventsV2.py --ged "%GEDFILE%"
if %errorlevel% neq 0 ( echo ERROR: GEDtoPersonalEventsV2.py failed & pause & exit /b %errorlevel% )

echo [3/4] birthLocationGroups.py  -^> birthLocationGroups.json
python birthLocationGroups.py
if %errorlevel% neq 0 ( echo ERROR: birthLocationGroups.py failed & pause & exit /b %errorlevel% )

echo [4/4] DeathLocationGroups.py  -^> DeathLocationGroups.json
python DeathLocationGroups.py
if %errorlevel% neq 0 ( echo ERROR: DeathLocationGroups.py failed & pause & exit /b %errorlevel% )

for %%F in (family.json personalHistoryEvents.json birthLocationGroups.json DeathLocationGroups.json) do (
    if not exist "%%F" ( echo ERROR: expected output %%F was not created & pause & exit /b 1 )
)

echo.
echo ===============================================
echo All files generated. Commit the updated *.json and push.
echo ===============================================
pause

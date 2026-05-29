@echo off
echo ===============================================
echo Updating Family Tree Data...
echo ===============================================


:: --- Ask for GED Filename ---
set /p GEDFILE=Enter the name of the GED file (e.g. Family.ged): 

echo.
echo You entered: %GEDFILE%
echo.

:: --- Verify File Exists ---
if not exist "%GEDFILE%" (
    echo ERROR: The file "%GEDFILE%" was not found.
    echo Make sure the file is in this folder.
    pause
    exit /b
)


REM ----- Step 1: Convert GED → Family.json -----
set /p ROOTID=Enter the root individual ID (e.g. @I310053455724@): 
echo Running Family_tree4.py... Creating family.json
python Family_tree4.py --ged "%GEDFILE%"   --root %ROOTID% --max-depth 25
if %errorlevel% neq 0 (
    echo ERROR: Family_tree4.py failed!
    pause
    exit /b %errorlevel%
)

REM ----- Step 2: Create PersonalEventsHistory.json -----
echo Running GEDtoPersonalEventsV2.py... Creating personalHistoryEvents.json
python GEDtoPersonalEventsV2.py
if %errorlevel% neq 0 (
    echo ERROR: GEDtoPersonalEventsV2.py failed!
    pause
    exit /b %errorlevel%
)

REM ----- Step 3: Create BirthLocationGroups.json -----
echo Running birthLocationGroups.py... Creating birthlocationGroups.json
python birthLocationGroups.py
if %errorlevel% neq 0 (
    echo ERROR: birthLocationGroups.py failed!
    pause
    exit /b %errorlevel%
)

:: --- Verify File Exists ---
if not exist birthlocationcolors.json (
    echo ERROR: The file birthlocationcolors.json was not found.
    echo Make sure the file is in this folder.
    pause
    exit /b
)
echo birthlocationcolors.json Exists

:: --- Verify File Exists ---
if not exist birthlocationgroups.json (
    echo ERROR: The file birthlocationgroups.json was not found.
    echo Make sure the file is in this folder.
    pause
    exit /b
)
echo birthlocationgroups.json Exists


echo ===============================================
echo All files successfully generated!
echo ===============================================
pause

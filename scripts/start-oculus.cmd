@echo off
rem Starts Oculus on this computer in its own window (T-056, D-088).
rem Double-click this file, or make a desktop shortcut to it. Closing the
rem Oculus window stops it. The very first time it also sets up Oculus's
rem database (T-057) and asks a few questions. The first time, and after each update
rem (git pull), it installs and builds Oculus first, which takes a few minutes.
setlocal
cd /d "%~dp0.."
set "INSTALLED="
if not exist "node_modules" (
  echo Installing what Oculus needs, the first time only...
  call npm ci || goto failed
  set "INSTALLED=1"
)
set "HEAD="
set "BUILT="
for /f %%h in ('git rev-parse HEAD 2^>nul') do set "HEAD=%%h"
if exist "packages\api\dist\.built-from" set /p BUILT=<"packages\api\dist\.built-from"
if not exist "packages\api\dist\desktop-cli.js" goto build
if defined HEAD if not "%HEAD%"=="%BUILT%" goto build
goto run

:build
echo Updating what Oculus needs and building it...
if not defined INSTALLED call npm ci || goto failed
call npm run build || goto failed
if defined HEAD (echo %HEAD%)>"packages\api\dist\.built-from"

:run
set "SETTINGS=%APPDATA%\Oculus"
if defined OCULUS_DESKTOP_HOME set "SETTINGS=%OCULUS_DESKTOP_HOME%"
if not defined OCULUS_DATABASE_URL if not exist "%SETTINGS%\desktop.json" goto database
goto start

:database
echo Setting up Oculus's database...
node packages\api\dist\desktop-database-cli.js || goto failed

:start
rem Node directly (not npm run), so its exit code arrives as it is.
node packages\api\dist\desktop-cli.js
rem 3: the database is made but the setup questions were never finished.
if "%ERRORLEVEL%"=="3" goto database
if errorlevel 1 goto failed
exit /b 0

:failed
echo.
echo Oculus did not start. The message above says why.
pause
exit /b 1

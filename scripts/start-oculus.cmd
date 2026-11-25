@echo off
rem Starts Oculus on this computer in its own window (T-056, D-088).
rem Double-click this file, or make a desktop shortcut to it. Closing the
rem Oculus window stops it. The first time, and after each update
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
call npm run desktop
if errorlevel 1 goto failed
exit /b 0

:failed
echo.
echo Oculus did not start. The message above says why.
pause
exit /b 1

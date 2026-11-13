@echo off
setlocal
set "SKILL_HOME=%~dp0"
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" (set "NODE=%SKILL_HOME%bin\win-arm64\node.exe") else (set "NODE=%SKILL_HOME%bin\win-x64\node.exe")
if not exist "%NODE%" (
  echo Missing bundled Node.js for this Windows architecture: "%NODE%" 1>&2
  exit /b 1
)
"%NODE%" "%SKILL_HOME%scripts\device-cli.mjs" %*
exit /b %errorlevel%

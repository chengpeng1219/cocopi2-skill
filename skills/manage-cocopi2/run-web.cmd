@echo off
setlocal
set "SKILL_HOME=%~dp0"
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" (set "NODE=%SKILL_HOME%bin\win-arm64\node.exe") else (set "NODE=%SKILL_HOME%bin\win-x64\node.exe")
if not exist "%NODE%" (echo Missing bundled Node.js: "%NODE%" 1>&2 & exit /b 1)
python -c "import paramiko; print('Paramiko', paramiko.__version__)" >nul 2>&1
if errorlevel 1 (echo Python 3 with Paramiko 5.x is required for saved-password Wi-Fi. Install it with: python -m pip install "paramiko>=5,<6". Paramiko is LGPL-2.1 and is not bundled. 1>&2 & exit /b 2)
set "STATE_DIR=%LOCALAPPDATA%\CocoPi2DeviceManager"
set "KEY_FILE=%STATE_DIR%\secret.key"
if not exist "%STATE_DIR%" mkdir "%STATE_DIR%"
if not exist "%KEY_FILE%" "%NODE%" -e "require('node:fs').writeFileSync(process.argv[1],require('node:crypto').randomBytes(32),{mode:0o600})" "%KEY_FILE%"
for /f "delims=" %%A in ('"%NODE%" -e "process.stdout.write(require('node:fs').readFileSync(process.argv[1]).toString('base64'))" "%KEY_FILE%"') do set "COCOPI2_SECRET_KEY=%%A"
set "COCOPI2_SECRET_FILE=%STATE_DIR%\ssh-password.json"
set "COCOPI2_SSH_HOST_KEY_MODE=accept-new"
set "COCOPI2_PYTHON=python"
set "HOST=127.0.0.1"
set "PORT=8787"
"%NODE%" "%SKILL_HOME%scripts\server.js"

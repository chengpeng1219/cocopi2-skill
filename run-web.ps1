$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$stateDir = Join-Path $env:LOCALAPPDATA 'CocoPi2DeviceManager'
$keyPath = Join-Path $stateDir 'secret.key'
New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
if (-not (Test-Path -LiteralPath $keyPath)) {
  $bytes = New-Object byte[] 32
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($bytes)
  $rng.Dispose()
  [System.IO.File]::WriteAllBytes($keyPath, $bytes)
  $acl = Get-Acl -LiteralPath $keyPath
  $acl.SetAccessRuleProtection($true, $false)
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', 'Allow')
  $acl.SetAccessRule($rule)
  Set-Acl -LiteralPath $keyPath -AclObject $acl
}
$secretKey = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($keyPath))
$env:COCOPI2_SECRET_KEY = $secretKey
$env:COCOPI2_SECRET_FILE = Join-Path $stateDir 'ssh-password.json'
$env:COCOPI2_SSH_HOST_KEY_MODE = 'accept-new'
$env:HOST = '127.0.0.1'
$env:PORT = '8787'
$env:COCOPI2_PYTHON = 'python'
Push-Location $root
try { & 'D:\Program Files\nodejs\node.exe' .\src\server.js }
finally {
  foreach($name in @('COCOPI2_SECRET_KEY','COCOPI2_SECRET_FILE','COCOPI2_SSH_HOST_KEY_MODE','HOST','PORT','COCOPI2_PYTHON')) { [Environment]::SetEnvironmentVariable($name,$null,'Process') }
  Pop-Location
}

# Third-party runtime notices

## Paramiko (optional local Wi-Fi password mode)

The web password bridge uses Paramiko 5.x when enabled by the local web service. Paramiko is distributed under LGPL-2.1; license text and source are published by the Paramiko project:

- Project: https://github.com/paramiko/paramiko
- License: https://github.com/paramiko/paramiko/blob/main/LICENSE

Paramiko is **not bundled** in this Skill ZIP. The user installs it into their own Python environment. The ZIP includes only a Python script that imports the package. CLI key-based SSH and USB/ADB operations do not require Paramiko.

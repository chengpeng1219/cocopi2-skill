import base64
import os
import sys
from pathlib import Path

import paramiko


def main():
    if len(sys.argv) != 8:
        print('usage: ssh_password_bridge.py host username port command_b64 timeout strict known_hosts_or_dash', file=sys.stderr)
        return 2
    host, username = sys.argv[1], sys.argv[2]
    port, command_b64 = int(sys.argv[3]), sys.argv[4]
    timeout = float(sys.argv[5])
    strict = sys.argv[6].lower() == 'true'
    known_hosts = sys.argv[7]
    port = int(sys.argv[3])
    length_line = sys.stdin.readline()
    if not length_line or not length_line.strip().isdigit():
        print('SSH password frame length is invalid', file=sys.stderr)
        return 2
    length = int(length_line.strip())
    if length < 1 or length > 4096:
        print('SSH password exceeds 4096 bytes', file=sys.stderr)
        return 2
    password_bytes = sys.stdin.buffer.read(length)
    if len(password_bytes) != length:
        print('SSH password frame is incomplete', file=sys.stderr)
        return 2
    password = password_bytes.decode('utf-8')
    del password_bytes
    if not password:
        print('SSH password was not provided on stdin', file=sys.stderr)
        return 2
    client = paramiko.SSHClient()
    host_key_path = Path(known_hosts).expanduser() if known_hosts != '-' else None
    if host_key_path is not None and host_key_path.is_file():
        client.load_host_keys(str(host_key_path))
    client.set_missing_host_key_policy(paramiko.RejectPolicy() if strict else paramiko.AutoAddPolicy())
    client.connect(host, port=port, username=username, password=password, timeout=timeout,
                   banner_timeout=timeout, auth_timeout=timeout, allow_agent=False, look_for_keys=False)
    if host_key_path is not None and not strict:
        host_key_path.parent.mkdir(parents=True, exist_ok=True)
        client.save_host_keys(str(host_key_path))
    command = base64.b64decode(command_b64).decode('utf-8')
    stdin, stdout, stderr = client.exec_command(command, timeout=timeout)
    out = stdout.read(1024 * 1024 + 1)
    err = stderr.read(1024 * 1024 + 1)
    sys.stdout.buffer.write(out[:1024 * 1024])
    sys.stderr.buffer.write(err[:1024 * 1024])
    code = stdout.channel.recv_exit_status()
    client.close()
    return code


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f'{type(error).__name__}: {error}', file=sys.stderr)
        raise SystemExit(1)

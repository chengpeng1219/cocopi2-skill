# CocoPi 2 Device Manager + Agent Skill

本仓库包含可在本机通过 SSH/ADB 连接 CocoPi 2 的设备管理服务，以及可供 Agent Skills 客户端加载的 [manage-cocopi2 技能](<skills/manage-cocopi2/SKILL.md>)。它支持设备扫描/连接、Linux 命令、后台程序与日志管理；不提供 GPIO/传感器等特定硬件控制。源码以 [MIT 许可证](<LICENSE>)发布；随包的 Node.js 有独立的[官方许可证](<skills/manage-cocopi2/references/NODE-LICENSE.txt>)。

## Wi-Fi 密码网页模式

只在网页服务运行的本机浏览器中使用密码连接时，可启动 `run-web.ps1`。该脚本将加密密钥保存在当前 Windows 用户的 `%LOCALAPPDATA%\\CocoPi2DeviceManager\\secret.key`，密码密文保存在同目录的 `ssh-password.json`；服务拒绝监听非回环地址。首次运行在网页中填入共享设备密码并点“保存本机设置”；每台新设备首次连接会自动接受并记录 SSH 主机指纹，后续同 IP 指纹变化仍拒绝。此功能使用系统 Python 3 与 Paramiko 5.x，运行前需自行安装 `python -m pip install "paramiko>=5,<6"`；Paramiko 按 LGPL-2.1 分发且不随 ZIP 打包。不要把生成的密钥/密码文件提交到仓库或公开。

## 对外分发

Windows/macOS 的便携 ZIP 发布在 GitHub Releases（发布步骤见 [PUBLISHING.md](<PUBLISHING.md>)）；仓库本身不提交各平台 Node.js 二进制，也不提交任何设备凭据/状态。下载 ZIP 后校验 Release 公告的 SHA256，完整解压 `manage-cocopi2/` 到客户端支持的技能目录并重新加载客户端。**把 GitHub 链接直接发到 CocoBuddy 聊天里自动安装尚未实现**；首次执行需要用户确认设备连接授权。USB 需要系统可用 adb，Wi-Fi 需要已配置 SSH 密钥与主机指纹。

## 本地开发

A local Node.js service manages computer-side SSH and ADB connections to CocoPi 2, runs Linux commands, and starts/stops background programs. It does not implement GPIO or sensor-specific commands.

## Requirements

- Node.js 20+
- `ssh` available on PATH, with a working private key and the device host key already present in `known_hosts`
- `adb` available for USB mode: either on PATH, or point the service at a full path

### 关于 adb 与 PATH（为什么别的应用能扫到）

手机助手、IDE 这类应用通常**自带 adb 并自己启动 adb server**（`127.0.0.1:5037`），它们根本不依赖系统 PATH——所以“别的应用能扫到设备”并不代表 `adb` 在 PATH 里。

部分手机助手把 adb 放在其安装目录的子目录中，虽能启动 adb server，本机进程也未必能从 PATH 找到 `adb`。

服务因此按以下顺序找设备：

1. 复用**已在运行的 adb server**（`127.0.0.1:5037`，smart-socket 协议 `host:devices-l`）；
2. 没有 adb server 时，尝试 `ADB_EXECUTABLE` 指定的路径（如果设置），否则尝试 PATH 中的 `adb`；本地开发服务另有少量 Windows pcsuite 安装目录兜底；便携 Skill 不依赖这些目录；
3. 全部失败才报错，并提示可设置 `ADB_EXECUTABLE`。

首次使用前请确认接收方系统具备可执行的 adb；设备扫描也可以复用已经启动的 adb server。

USB 发现可以直接走 adb server；但连接后的终端命令仍需要一个可执行的 adb（`adb -s SERIAL shell`），所以长期使用建议安装官方 platform-tools 并设置 `ADB_EXECUTABLE`。

### 指定 adb.exe 路径（不在 PATH 时）

如果 adb 不在 PATH 里，启动服务前指向电脑上**自己的** adb 安装路径，不需要修改系统 PATH：

```powershell
$env:ADB_EXECUTABLE = 'C:\Android\platform-tools\adb.exe'  # 改成接收方实际路径
```

服务对所有 USB 操作（发现、连接、状态、设备信息、终端命令）都使用该路径；找不到时错误信息里会回显这个路径。**通常不需要设置**：未设置时服务会自动找 PATH、运行中的 adb server 和常见安装位置。

## Run

```powershell
npm test
$env:HOST = '127.0.0.1'
$env:PORT = '8787'
$env:ADB_EXECUTABLE = 'C:\Android\platform-tools\adb.exe'   # 可选，按本机实际路径填写
npm start
```

Service defaults to loopback only. Open `http://127.0.0.1:8787/` in your browser for the local device-management page. It offers Wi-Fi SSH test/connect, USB ADB scan, and a connected-device list with status/info/disconnect actions. The page and API work only while the Node.js service is running; restart it after upgrading the code. Do not bind to a public interface without adding authentication and access controls.

## HTTP tool endpoints

All POST endpoints accept a JSON object and return `{ "result": ... }`. Errors return `{ "error": "..." }`.

- `GET /health`
- `POST /tools/test_ssh` — 诊断 SSH 连接：`{ "host": "192.168.1.50", "username": "root", "port": 22, "timeoutMs": 8000 }`。仅运行固定的 `true` 命令并返回 stdout/stderr/error 分类，不修改设备。用户名必填；如密钥对应非 root 账户请填写正确账号。
- `GET /tools`
- `GET /devices`
- `POST /tools/discover_devices` — `{ "transports": ["usb"], "hosts": ["cocopi.local"], "timeoutMs": 8000 }`. USB calls `adb devices -l`; Wi-Fi records explicitly supplied candidate hosts (it does not perform broad network scans).
- `POST /tools/list_devices` — optional `{ "transport": "wifi", "state": "connected" }`
- `POST /tools/connect_device` — Wi-Fi: `{ "transport": "wifi", "host": "cocopi.local", "port": 22 }`; USB: `{ "transport": "usb", "adbSerial": "SERIAL" }`. A discovered Wi-Fi ID may instead be used as `{ "deviceId": "...", "transport": "wifi" }`.
- `POST /tools/disconnect_device` — `{ "deviceId": "..." }`. For SSH, this forgets the manager's session record; SSH is command-per-connection. For USB, it runs `adb disconnect SERIAL`.
- `POST /tools/get_connection_status` — `{ "deviceId": "..." }`
- `POST /tools/get_device_info` — `{ "deviceId": "..." }`; returns `uname -a` as a basic connectivity check.
- `POST /tools/run_command` — `{ "deviceId": "...", "command": "uname -a", "timeoutMs": 30000 }`（默认 30 秒，上限 120 秒）。Wi-Fi 设备通过 SSH 执行该命令，USB 设备通过 `adb shell sh -c` 执行；返回 `{ ok, exitCode, stdout, stderr, truncated, command, startedAt, finishedAt }`。命令失败（非 0 退出码、超时、连接错误）以 HTTP 200 返回结构体，`ok: false`，不会变成模糊的 502。

### 网页终端

打开 `http://127.0.0.1:8787/`，在“设备列表”连接设备后，页面底部“终端”面板会自动列出已连接设备。输入 Linux 命令（如 `uname -a`、`ls /dev`、`cat /sys/class/thermal/thermal_zone0/temp`）点击“运行命令”，或按 `Ctrl+Enter`；输出、stderr 和退出码会追加在终端里。顶部快捷按钮提供常用只读命令。

每条命令是独立的 SSH/ADB 调用，**不保留会话状态**：`cd`、`export`、后台交互进程都不会延续到下一条命令。需要持续运行的程序请用下面的“程序”面板。

### 程序（在设备上后台运行）

网页的“程序”面板对应 4 个工具，让已连接设备上的程序长期后台运行，退出 SSH/ADB 也不受影响：

- `POST /tools/start_program` — `{ "deviceId": "...", "name": "LED 闪烁", "command": "python3 /root/main.py", "workdir": "/root" }`。命令由设备上的 `nohup` 拉起，输出写入 `/tmp/cocopi2-programs/<id>.log`，PID 记在 `<id>.pid`；启动后等待 1 秒检查进程是否存活，返回 `{ ok, state: "running" | "exited", id, log }`。命令会先写入 `<id>.run.sh` 再执行，避免多层引号在 adb shell 中被反复解析。
- `POST /tools/list_programs` — `{ "deviceId": "..." }`。列出本服务启动并登记过的程序及其真实状态（`running` / `stopped`）和 PID。
- `POST /tools/stop_program` — `{ "deviceId": "...", "programId": "..." }`。先发 `SIGTERM`，1 秒后仍未退出则 `SIGKILL`，返回 `state: "stopped" | "stop_failed"`。
- `POST /tools/program_log` — `{ "deviceId": "...", "programId": "...", "lines": 200 }`。返回日志尾部（最多 32KB，超出则保留末尾）。

网页上：选目标设备 → 填程序名称与启动命令（可选工作目录）→ “启动程序”，下方列表显示状态/PID，点“日志”查看输出、点“停止”结束进程。程序列表保存在设备上的 `/tmp/cocopi2-programs/`，重启服务不会杀掉已启动的程序，但重启后需重新启动才能在列表里看到（服务重启会清空登记信息）。

### 关于 adb shell 与命令执行

在一台测试设备上（`/bin/sh` → bash）在收到 `adb -s SERIAL shell '<多行脚本>'` 时会被拆成多条命令执行，`for … do;` 之类的结构还会因 `do;` 报语法错误。因此服务对多语句命令采用“先写脚本文件、再 `sh 文件` 运行”的方式，并在遇到 `syntax error` 类 adb shell 传输错误时自动切换；程序启动脚本则统一使用 `; ` 分隔的扁平结构配合设备端脚本文件。

SSH uses OpenSSH `BatchMode=yes` and `StrictHostKeyChecking=yes`; private keys are not passed as tool arguments. Configure keys/host keys through the normal local OpenSSH setup. ADB authorization is expected to be configured on the device. Device IDs are in-memory and reset when the service restarts.

## Safety and scope

- `run_command` 会以设备登录账户的权限执行任意 Linux 命令（默认 `root`），包括可能损坏系统或硬件的操作。不要在共享电脑上运行，也不要把服务暴露到局域网或公网。
- `start_program` 同样以设备账户权限在后台运行任意命令，`stop_program` 只能停止由本服务记录的程序；重启服务后这些记录会清空，此时请用“终端”面板手动 `kill`。
- The service binds to `127.0.0.1` by default and has no authentication. Keep it local.
- A successful status check means the fixed SSH/ADB command completed, not that peripherals are working.
- SSH disconnect cannot terminate arbitrary processes running on the device. This MVP manages connection checks, not hardware safety or emergency stop.

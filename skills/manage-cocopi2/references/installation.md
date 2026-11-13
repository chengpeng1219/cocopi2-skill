# 安装和运行（Windows / macOS）

1. 复制完整 `manage-cocopi2/` 目录（`SKILL.md`、`scripts/`、`references/`、`bin/`、`run.cmd`、`run.sh`、`run-web.cmd`、`run-web.sh`）到支持 Agent Skills 的客户端技能目录，并重启/重新加载客户端。若客户端不支持 Agent Skills，仍可直接运行启动脚本，但不会自动触发技能。不同客户端的技能扫描目录以其自身文档为准。
2. 使用系统对应的 `<launcher>`：Windows x64/arm64 用 `<skill-dir>\run.cmd`；macOS x64/arm64 用 `<skill-dir>/run.sh`。macOS 若解压后脚本没有执行位，运行 `chmod +x <skill-dir>/run.sh <skill-dir>/bin/<平台>/node`。不需要安装 Node.js、不改系统 PATH；Linux 不在此包的支持范围内。完整 ZIP 体积包含 4 份 Node.js 运行时；可仅保留接收方所在平台的 `bin/<平台>/node` 减小体积。
3. 在项目工作目录运行：`<launcher> doctor`。它不会修改设备。USB 需 adb 和设备授权；Wi-Fi 需 OpenSSH、本机可用 SSH 密钥和正确的 known_hosts。失败输出不会自动安装依赖。
4. USB 流程：`scan` → `connect-usb --serial <扫描结果 adbSerial>` → `devices` / `status --device <返回的 deviceId>`。
5. Wi-Fi 流程：先在可信渠道核对设备 SSH 指纹并让电脑的 known_hosts 生效 → `connect-wifi --host <IP> --user <账户名> --port 22`。首次需要口令或密码时，先让用户在自己的终端完成 SSH 设置；本工具不采集密码。
6. 要网页时，Windows 运行 `<skill-dir>\\run-web.cmd`，macOS 运行 `<skill-dir>/run-web.sh`，浏览器打开 `http://127.0.0.1:8787/`。该启动器创建本机加密密钥与密码文件，服务只绑定回环地址；关闭终端即停止服务。不要把 HOST 改为 `0.0.0.0`。网页 Wi-Fi 面板可保存全校统一设备密码，首次连接自动记录指纹，之后指纹改变仍会失败。

## 状态文件

默认路径：运行命令时的工作目录下 `.cocopi2/manager.json`。只保存设备连接元信息和程序登记信息；不会保存 SSH 私钥或账号密码。这个文件包含设备 IP/命令，避免上传到公共仓库；可将 `.cocopi2/` 加到 `.gitignore`。`--state <绝对路径>` 可指定另一个状态文件；不要把状态文件放进技能安装目录。CLI 调用均加载并保存该文件；删除文件后须重新扫描/连接，设备上此前启动的进程不会因此停止。

## 输出和错误

成功输出 JSON：`{"ok":true,"result":...}`；失败输出 JSON：`{"ok":false,"error":"..."}` 且退出码非 0。某些设备命令以 exitCode != 0 返回，但 CLI 本身能正常返回 JSON；检查结果内部的 `ok` 与 `stderr`。`run`、`start` 可以执行任意 shell 命令，应只运行用户明确要求的命令。

## 可执行文件

- 网页密码连接需要系统 Python 3 和 Paramiko 5.x；启动器会检查，缺失时请在用户终端按提示运行 `python -m pip install "paramiko>=5,<6"`（macOS 用 `python3`）。Paramiko 按 LGPL-2.1 单独分发，不包含在此 ZIP。CLI SSH 密钥和 USB 功能不依赖它。
- Node.js 便携运行时取自 [nodejs.org v24.22.3](https://nodejs.org/dist/v24.22.3/)，可验证的哈希在 `runtime-manifest.json`，官方许可证见 `NODE-LICENSE.txt`；该包只是调用官方可执行文件，不会修改系统 Node 安装。
- CLI SSH 使用接收方操作系统的 OpenSSH 与已配置密钥。网页密码连接使用系统 Python 3 + Paramiko 5.x（Windows/macOS 均需预装；启动器会检查缺失依赖）；密码由本机 AES-256-GCM 加密文件读取，经 stdin 长度帧交给 Python，不在 HTTP 请求、命令行或日志中出现。首次连接自动接受主机指纹并写入用户 `known_hosts`，同一 IP 指纹改变后校验失败。
- ADB 优先使用环境变量 `ADB_EXECUTABLE`（指向可执行文件完整路径）；否则尝试 PATH 中的 `adb`，Windows 上还检查 PATH 内 `pcsuite` 目录的 `adb_41/adb.exe` 或 `adb/adb.exe` 与系统 Program Files 下的相邻目录。**不固定开发者的 D: 盘路径**。便携包不附带 adb；ADB server (`127.0.0.1:5037`) 可用于扫描，但连接、命令执行仍需 adb 可执行文件。执行 `<launcher> doctor` 可查看实际解析出的 adb 路径。第三方系统权限与设备授权不会因解压技能而自动授予。
- 运行前确认当前目录和目标设备；改变当前目录会改用不同的 `.cocopi2/manager.json`。
---
name: manage-cocopi2
description: 在用户电脑上以 SSH 密钥或 USB/ADB 连接 CocoPi 2，并通过随附 Node.js 工具管理设备、执行 Linux 命令和后台程序。
whenToUse: 用户说“连接 CocoPi 2”“扫描 CocoPi USB”“查看设备状态”“在 CocoPi 上运行程序”“查看日志或停止程序”时使用。
user-invocable: true
---

# 管理 CocoPi 2

目标：在本机连接 CocoPi 2；报告设备状态、信息和程序运行结果，不编造硬件控制效果。

1. **定位运行环境**。随包附带 Windows、macOS 的 Node.js，Windows 用 `<skill-dir>\run.cmd`，macOS 用 `<skill-dir>/run.sh`（解压后必要时 `chmod +x`）；Linux 不受支持。首次使用运行 `<launcher> doctor`，确认 SSH/ADB 能被本机调用。所有 `--host`、`--serial` 等参数都是**本机工具参数**，不是云平台凭据。
2. **选连接方式**。USB：设备已插线并授权后运行 `<launcher> scan`；扫描记录中的 `adbSerial` 即设备序列号，将它列给用户选，再运行 `<launcher> connect-usb --serial cocopi2`。Wi-Fi：向用户要 IP/主机名与 SSH 用户名，先在用户终端核实主机指纹，再运行 `<launcher> connect-wifi --host 192.168.1.50 --user root --port 22`。SSH 使用本机已有密钥，不询问用户在聊天中贴私钥或密码。
3. **管理设备**。以上连接成功后用 `<launcher> devices` 读取 `deviceId`；`<launcher> status --device <id>`、`<launcher> info --device <id>` 和 `<launcher> disconnect --device <id>` 分别检查、读取系统信息、断开记录。每次命令以 JSON 输出 `{ ok, result }` 或 `{ ok:false, error }`；必须按实际结果答复。
4. **执行命令/程序（用户明确提出时）**。命令：`<launcher> run --device <id> --command "uname -a"`；后台程序：`<launcher> start --device <id> --name "监测" --command "python3 /root/main.py" --workdir /root`。然后运行 `<launcher> programs --device <id>` 读取程序 id；`<launcher> log --device <id> --program <programId> --lines 80` 查看日志；`<launcher> stop --device <id> --program <programId>` 停止。执行任意 shell 命令有真实设备风险，危险或破坏性操作须先让用户确认具体命令。
5. **交付与复核**。告知所用连接方式、设备标识、状态、命令退出码及 stdout/stderr（如有）；异常时报告 `error`，不要把请求送到别人的云端。需要网页时可运行 `<launcher> web`，打开它显示的本地 URL（默认 `http://127.0.0.1:8787/`）。

## 安装与状态

将整个 `manage-cocopi2/` 目录复制到使用者环境的 Agent Skills 目录，重新加载/重启客户端；具体技能目录以客户端文档为准，不能假定客户端会加载任意本地目录；`scripts/` 内的模块必须一起复制。CLI 在**当前工作目录**的 `.cocopi2/manager.json` 保存设备连接地址和程序命令（不含凭据），请勿公开此文件；切换项目目录不会自动共享设备列表。若希望复用同一批记录，从同一工作目录执行命令。此文件不包含私钥或密码。首次使用与升级请先查 `references/installation.md`。

## 边界与故障

- USB 扫描可复用已运行的 adb server，但连接和终端命令仍需本机 adb 可执行文件。Windows 会检查 PATH 与相邻的 `pcsuite/adb_41`、`pcsuite/adb` 安装位置；`doctor` 显示实际找到的 adb。未找到时先让用户提供本机 adb 路径并配置 `ADB_EXECUTABLE`，不存在才提示安装；不能宣称 Skill 会完成驱动/设备授权。
- Wi-Fi 需要可达的 TCP/22（或指定端口）、本机 SSH 密钥及已确认的 `known_hosts`；本技能不会跳过指纹检查，不接收密码。不提供 mDNS/局域网盲扫。
- `run` 是单次非交互命令；后台任务用 `start`。后台程序使用设备 `/tmp/cocopi2-programs/`，设备重启/清理 `/tmp` 后文件与日志会丢失；停止操作只针对本工具记录的 id。
- CocoPi 2 的 GPIO/灯/温度传感器没有抽象工具；`info` 仅运行 `uname -a`，不得声称已控制某个区的硬件。
- `web` 启动无认证 HTTP 本地服务，只允许 `127.0.0.1`；网页状态与 CLI 状态相互独立，网页关闭/服务重启清空其设备列表。

## 绝对不要

- 不要把电脑上的 SSH 私钥、密码或 token 写进命令参数、Skill 文件、状态文件或聊天记录。
- 不要为了连接失败自动添加 `StrictHostKeyChecking=no` 或开放监听地址。
- 不要把 `ADB_EXECUTABLE` 固定为开发者电脑的安装路径；由接收方系统确定 adb 位置。
- 不要把“程序已启动”当成传感器/灯控制成功；必须看状态或日志。
- 不要在没连上设备时伪造 deviceId/PID/命令结果。
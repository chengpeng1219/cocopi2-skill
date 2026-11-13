# 发布 CocoPi 2 Skill 到 GitHub

目标仓库：[chengpeng1219/cocopi2-skill](https://github.com/chengpeng1219/cocopi2-skill)。仓库保存可审查的 Skill 源码、构建脚本、测试和许可证；**不把 Node.js 二进制或 ZIP 提交到 Git**（GitHub 单文件限制 100 MB）。

## 发布步骤

1. 审查拟发布的文件和 MIT 源码授权；确认不包含 `.env`、私钥、设备状态文件或开发者绝对路径。`skills/manage-cocopi2/references/NODE-LICENSE.txt` 是随运行时分发所需的 Node.js 官方许可文本。
2. 在仓库根目录运行 `node --test`；运行 `python build-portable-skill.py` 时先按 `skills/manage-cocopi2/references/runtime-manifest.json` 从 [Node.js 官方发行站](https://nodejs.org/dist/v24.22.3/)获取对应的四个平台二进制文件到 `skills/manage-cocopi2/bin/<platform>/node[.exe]`，构建脚本会拒绝 SHA256 不匹配的文件。
3. 把源码提交并推送到仓库 `main`；保持 ZIP 和 `bin/<platform>/` 被 `.gitignore` 排除。
4. 给已发布的提交创建不可变版本 tag，例如 `v0.1.2`；使用 GitHub Release 上传 `manage-cocopi2-portable-skill.zip` （约 146 MB），并在 Release 描述中填写 ZIP 的 SHA256、支持的 OS 与 ADB/SSH 外部条件。**发布 Release asset 不等于把 ZIP 放进 Git 仓库。**
5. 别人下载 Release asset，验证 SHA256 后把整个 `manage-cocopi2/` 放到其客户端支持的 Skills 目录，重新加载客户端。

## 仅靠 GitHub 链接不能自动安装

目前已确认 DSH 运行时的 skill-filesystem provider 能从本地 `.dsh/skills`、`.agents/skills`、用户 Skills 目录发现 `SKILL.md`，但没有已验证的「把 GitHub URL 粘到 CocoBuddy 聊天里便自动安装」入口。CocoBuddy 桌面客户端源码不在当前工作区；要开发内置链接安装 UI，需要取得其源码并实现：固定版本/哈希与文件预览 → 用户明确确认 → 严格限制目标技能目录、拒绝路径穿越/符号链接与覆盖 → 解压（不执行仓库脚本）→ 刷新技能目录。不要以普通回复承诺已实现客户端自动安装。

## 便携包限制

ZIP 内含 Windows x64/arm64、macOS Intel/Apple Silicon 四份 Node.js v24.22.3；**未内置 adb、OpenSSH、Paramiko、设备驱动或 SSH 凭据**。CLI SSH 需要已配置密钥；网页密码模式另需 Python 3 + Paramiko 5.x，并只监听本机。首次连接自动记住新设备指纹，之后指纹变化会拒绝。USB 仍需 adb 与设备授权。macOS 运行未在本机实测，真实设备 SSH 密码桥接也未验证；发布说明应显式标明此限制。

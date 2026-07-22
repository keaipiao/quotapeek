# Codex Quota

[English](README.md)

Codex Quota 会在 Windows 版 Codex/ChatGPT 的侧栏底部加入一个紧凑、只读的额度面板。它只显示通用额度，不遮挡会话记录或账号菜单，也没有托盘图标和独立窗口。

这是非官方社区项目，并非由 OpenAI 制作或支持。

## 安装

使用要求：Windows 11 x64、Microsoft Store 版 Codex/ChatGPT（`OpenAI.Codex`）、Node.js 22 或更高版本，并已在 Codex 中登录 ChatGPT 账号。

1. 如有需要，先安装 [Node.js 22 或更高版本](https://nodejs.org/)。
2. 完全退出所有 Codex/ChatGPT 桌面进程。
3. 从开始菜单打开 **PowerShell**。停留在默认目录即可，也可以在 Codex Quota 源码目录之外的其他目录执行；无需克隆仓库，也无需运行 `cd`。
4. 运行：

   ```powershell
   npx.cmd --yes @elonmark/codex-quota@latest install
   ```

5. 安装成功后，直接双击桌面或开始菜单中的 **Codex + Quota**。

安装命令只负责安装并创建快捷方式，**不会启动 Codex**。安装后无需再运行一次 `npx ... start`。Codex Quota 会自动存放在 `%LOCALAPPDATA%\CodexQuota`，无需进入该目录。

以后每次完全退出 Codex 后，都通过 **Codex + Quota** 冷启动；Codex 已运行时，仍可使用官方图标将同一进程切回前台。

## 显示内容

- 只显示 Codex 通用额度，不显示模型专属的重复限额。
- 显示识别到的套餐，例如 Free、Plus、Pro 5× 或 Pro 20×。
- 显示剩余百分比、限额周期、重置时间和倒计时。
- 剩余高于 50% 显示绿色，20%–50% 显示黄色，低于 20% 显示红色。
- 实时数据返回前，以“正在刷新”显示最近一次缓存值。

面板会自动跟随 Codex 的界面语言，内置英文、简体中文和繁体中文；其他语言回退为英文。有可用数据时，Codex Quota 会隐藏侧栏中含义相同的原生额度，包括低额度提醒卡片。

### 数据新鲜度

**可能已过期**并不是额度本身已经过期，而是最近一次成功读取额度已超过 3 分钟。Codex Quota 通常每 60–120 秒刷新一次；读取失败后会在 5、15、30 秒后快速重试，本地 app-server 持续不可用时则保持每 30 秒重试。下一次读取成功后会自动恢复为**实时**。对于普通读取失败，只有连续 3 分钟未能成功读取才会出现此提示，超过 15 分钟的旧值将不再显示；provider 或 Codex 会话已经关闭时则可能立即显示不可用。

## 更新

Codex 桌面应用的常规更新不需要重新安装 Codex Quota。更新 Codex Quota 本身时，在 PowerShell 默认目录或 Codex Quota 源码目录之外重新运行下面的命令，完全退出 Codex，再通过 **Codex + Quota** 打开：

```powershell
npx.cmd --yes @elonmark/codex-quota@latest install
```

更新会安全替换本项目创建的快捷方式，包括旧名称 **QuotaPeek for Codex**；不属于 Codex Quota 的同名快捷方式会保留。

## 故障排查

如果额度面板没有出现：

1. 完全退出 Codex/ChatGPT，必要时在任务管理器中确认。
2. 通过 **Codex + Quota** 冷启动，不要使用官方快捷方式。
3. 在 PowerShell 默认目录或 Codex Quota 源码目录之外运行：

   ```powershell
   npx.cmd --yes @elonmark/codex-quota@latest doctor --live
   ```

如果隐藏启动没有反应，请查看 `%LOCALAPPDATA%\CodexQuota\logs\launcher-error.log`。不要公开上传 `auth.json`、`%LOCALAPPDATA%\CodexQuota` 的内容或未经检查的原始日志。

也可以不用快捷方式，直接在 PowerShell 默认目录或 Codex Quota 源码目录之外运行：

```powershell
npx.cmd --yes @elonmark/codex-quota@latest start
```

## 卸载

在 PowerShell 默认目录或 Codex Quota 源码目录之外运行下面的命令，然后完全退出 Codex，并通过官方快捷方式重新打开：

```powershell
npx.cmd --yes @elonmark/codex-quota@latest uninstall
```

## 安全与开发

Codex Quota 不会修改 Store 软件包、`app.asar`、Codex 配置或账号凭据。它使用随机的本机回环 CDP 端口和官方本地 app-server。完整安全边界见 [SECURITY.md](SECURITY.md)，可视化概览见[安全结构图](https://github.com/keaipiao/codex-quota/blob/main/docs/assets/codex-quota-security-architecture-zh.png)。

```powershell
npm.cmd run check
npm.cmd test
npm.cmd pack --dry-run
```

贡献说明见 [CONTRIBUTING.md](CONTRIBUTING.md)，发布流程见 [docs/RELEASING.md](docs/RELEASING.md)，许可证为 [MIT](LICENSE)。

## 社区

Codex Quota 认可并感谢开源社区 [LINUX DO](https://linux.do/)。

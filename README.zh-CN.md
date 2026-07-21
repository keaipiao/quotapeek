# QuotaPeek for Codex

[English](README.md)

QuotaPeek 会在 Windows 版 Codex/ChatGPT 桌面应用的侧栏底部加入一个紧凑、只读的额度面板。它位于账号区域上方，不会遮住会话记录或账号菜单，也没有托盘图标和独立窗口。

这是非官方社区项目，并非由 OpenAI 制作或支持。QuotaPeek 支持 Codex 桌面应用的常规版本更新，通常无需在 Codex 更新后重新安装：每次冷启动都会重新发现当前 Store 软件包和渲染器。如果诊断提示需要适配，请安装最新版 QuotaPeek。

## 显示内容

- 只显示 Codex 通用额度，不显示模型专属的重复限额。
- 显示已识别的套餐，例如 Free、Plus、Pro 5× 或 Pro 20×。
- 显示剩余百分比、限额周期、重置时间和倒计时。
- 剩余额度降低时，进度条会从绿色变为橙色、红色。
- 实时数据返回前，以“正在刷新”显示最近一次缓存值。

QuotaPeek 会自动跟随 Codex 的界面语言，内置英文、简体中文和繁体中文；其他语言回退为英文。面板有可用数据时，会隐藏账号区域中含义相同的原生额度。

## 使用要求

- Windows 11 x64
- Microsoft Store 版 Codex/ChatGPT（`OpenAI.Codex`）
- [Node.js 22 或更高版本](https://nodejs.org/)
- 已在 Codex 中登录 ChatGPT 账号

## 快速安装

1. 如果尚未安装，请先安装 [Node.js 22 或更高版本](https://nodejs.org/)。

2. 完全退出所有 Codex 或 ChatGPT 桌面进程。

3. 从开始菜单打开 **PowerShell**。保持它默认打开的目录即可，也可以在任意其他目录操作；不需要克隆仓库，也不需要执行 `cd`。

4. 运行：

   ```powershell
   npx.cmd --yes quotapeek@latest install
   ```

5. 看到安装成功提示后，直接双击桌面或开始菜单中的 **Codex + Quota**。

> `install` 命令只负责安装 QuotaPeek 并创建两个快捷方式，**不会启动 Codex**。安装成功后直接使用快捷方式即可，不需要再运行一次 `npx ... start`。

QuotaPeek 会自动安装到 `%LOCALAPPDATA%\CodexQuota`，不需要进入该目录。以后每次完全退出 Codex 后，都通过 **Codex + Quota** 冷启动；进程已经运行时，可以用官方 Codex 图标聚焦它。

### 可选：从终端启动

下面的命令是双击快捷方式的替代方法，不是安装后的必做步骤。它可以在任意 PowerShell 目录运行：

```powershell
npx.cmd --yes quotapeek@latest start
```

这里使用 `npx.cmd`，可避免 PowerShell 执行策略拦截 `npx.ps1`，无需修改系统执行策略。

## 更新

Codex 桌面应用的常规更新通常不需要额外操作，也不需要重新安装 QuotaPeek。更新 QuotaPeek 本身时，在任意 PowerShell 目录重新运行安装命令，完全退出 Codex，再通过 **Codex + Quota** 打开：

```powershell
npx.cmd --yes quotapeek@latest install
```

## 故障排查

如果额度面板没有出现：

1. 完全退出 Codex/ChatGPT，必要时在任务管理器中确认。
2. 通过 **Codex + Quota** 重新打开，不要使用官方快捷方式冷启动。
3. 在任意 PowerShell 目录运行诊断：

   ```powershell
   npx.cmd --yes quotapeek@latest doctor --live
   ```

如果隐藏启动仍然没有反应，请查看：

```text
%LOCALAPPDATA%\CodexQuota\logs\launcher-error.log
```

分享诊断结果前请先自行检查。不要公开上传 `auth.json`、`%LOCALAPPDATA%\CodexQuota` 的内容或原始日志。

## 卸载

在任意 PowerShell 目录运行下面的命令，然后完全退出 Codex，并通过官方快捷方式重新打开：

```powershell
npx.cmd --yes quotapeek@latest uninstall
```

## 安全与隐私

QuotaPeek 不会修改 Store 软件包、`app.asar`、Codex 配置或账号凭据。它使用随机的本机回环 CDP 端口和官方本地 app-server。同一 Windows 用户下的进程之间没有 CDP 身份验证，因此请只运行你信任的软件。短期本地缓存不包含凭据、邮箱、会话、DOM 内容或套餐信息。

完整的安全边界和报告方式请参阅 [SECURITY.md](SECURITY.md)。

## 开发

```powershell
npm.cmd run check
npm.cmd test
npm.cmd pack --dry-run
```

贡献说明见 [CONTRIBUTING.md](CONTRIBUTING.md)，发布流程见 [docs/RELEASING.md](docs/RELEASING.md)。

## 许可证

[MIT](LICENSE)

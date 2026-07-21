# Codex 侧栏额度

[English](README.md)

Codex 侧栏额度会在 Windows 版 Codex/ChatGPT 桌面应用的侧栏底部加入一个紧凑、
只读的额度面板。面板位于账号区域上方，参与侧栏正常布局，不会遮住会话记录或账号
菜单；没有托盘图标，也不会弹出独立额度窗口。

> [!IMPORTANT]
> 这是一个非官方、实验性的社区项目，并非 OpenAI 制作、认可或支持的产品。它依赖
> 桌面应用的私有 DOM 结构和内置的 `codex app-server`，应用更新可能导致功能失效。

项目不会修改 Microsoft Store 安装包、`app.asar`、Codex 配置或账号凭据。它使用随机
的本机回环 CDP 端口冷启动官方应用，验证进程和渲染器身份，通过官方本地 app-server
读取标准化额度，然后插入一个小型 Shadow DOM 组件。

## 功能

- 只显示 Codex 通用额度，不显示模型专属的重复限额。
- 显示剩余百分比、真实限额周期、刷新时间和倒计时。
- 额度降低时由绿色变为橙色、红色。
- 支持的重新启动中会先显示缓存值和“正在刷新”，实时数据返回后自动替换。
- 根据 Codex 界面语言自动切换英文、简体中文或繁体中文。优先采用 Codex 当前激活的
  React-Intl locale，再回退到 DOM/浏览器语言提示；不支持的语言回退英文。日期、时间、
  数字和百分比仍使用 Codex 当前的区域设置，不连接任何在线翻译服务。
- 自制面板有可用数据时，安全隐藏账号区域旁相同含义的原生额度，避免出现两份额度。

## 支持范围

| 组件 | 支持情况 | 说明 |
| --- | --- | --- |
| 操作系统 | Windows 11 x64 | 暂不支持 Windows 10、Windows on Arm、macOS 和 Linux。 |
| 桌面应用 | Microsoft Store `OpenAI.Codex` 软件包 | 界面产品名可能显示为 Codex 或 ChatGPT；其他发行方式未验证。 |
| Node.js | 22 或 24 | 最低要求 Node.js 22；CI 同时测试 Node 22 和 24。 |
| 账号 | 已登录、由 ChatGPT 支持的 Codex 账号 | 仅 API Key 或未登录状态无法提供所需额度。 |
| 项目版本 | 最新 `0.2.x` | 由于依赖私有桌面结构，兼容性只能尽力保障。 |

## 快速安装

先安装 [Node.js 22 或更高版本](https://nodejs.org/)，并完全退出所有 Codex 或
ChatGPT 桌面进程。然后在 PowerShell 中运行：

```powershell
npx.cmd --yes codex-sidebar-quota@latest install
```

从开始菜单或桌面启动新建的 **Codex + Quota** 快捷方式。安装程序会把不可变的运行时
快照保存到 `%LOCALAPPDATA%\CodexQuota` 并创建当前用户快捷方式，不会全局安装 npm
命令。

如果 PowerShell 执行策略拦截 `npx.ps1`，使用 `npx.cmd` 即可，无需修改执行策略。

### 安装固定版本

需要可复现安装时请固定版本：

```powershell
npx.cmd --yes codex-sidebar-quota@0.2.0 install
```

### 使用 GitHub Release 安装包

从 Release 附件同时下载 `codex-sidebar-quota-0.2.0.tgz` 和对应的 `.sha256` 文件，
验证后再运行：

```powershell
$archive = ".\codex-sidebar-quota-0.2.0.tgz"
$expected = ((Get-Content "$archive.sha256" -Raw) -split '\s+')[0].ToLowerInvariant()
$actual = (Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw "SHA-256 mismatch" }

npx.cmd --yes --package $archive codex-sidebar-quota install
```

## 为什么首次必须冷启动

CDP 是 Electron 进程启动参数，无法在桌面进程已经运行后补开。因此，完全退出后的
第一次启动必须使用 **Codex + Quota**，或运行：

```powershell
npx.cmd --yes codex-sidebar-quota@0.2.0 start
```

启动器不会强制结束或重启已有 Codex 进程。如果应用已在没有目标 CDP 端点的情况下
运行，请完全退出后重试。成功冷启动后，再点击官方图标只会聚焦同一进程，面板会继续
存在。

仅仅开启 CDP 仍然不够：本地伴随进程还需要验证浏览器身份、监控渲染器重建、读取
额度、注入面板并维持心跳。

## 诊断

运行本地只读检查：

```powershell
npx.cmd --yes codex-sidebar-quota@0.2.0 doctor
npx.cmd --yes codex-sidebar-quota@0.2.0 doctor --live
```

`--live` 会额外启动官方本地 app-server，检查 ChatGPT 账号是否可以返回额度桶；加入
`--json` 可以获得机器可读结果。

doctor 不输出额度数值、邮箱、认证 Token、会话内容或 DOM 内容，并会脱敏已知的
`USERPROFILE` 和 `LOCALAPPDATA` 路径前缀。不过，在公开粘贴输出前仍应自行检查，并
按需删除残留的本机路径、进程 ID 或环境信息。绝对不要上传 `auth.json`、
`%LOCALAPPDATA%\CodexQuota`、会话文件或原始日志。

如果隐藏启动没有反应，请只在本机查看
`%LOCALAPPDATA%\CodexQuota\logs\launcher-error.log`，再从可见终端运行
`doctor --live`。

## 更新

覆盖安装新版本，完全退出桌面应用，再使用 **Codex + Quota** 冷启动：

```powershell
npx.cmd --yes codex-sidebar-quota@latest install
```

当前进程会继续使用已经验证的旧快照，下一次冷启动才使用新版本。

## 卸载

```powershell
npx.cmd --yes codex-sidebar-quota@latest uninstall
```

该命令会停止已验证的伴随进程、删除它拥有的快捷方式，并删除
`%LOCALAPPDATA%\CodexQuota`。桌面进程在完全退出前仍可能开启着 CDP；退出后用官方
快捷方式重新打开，即可恢复普通的非 CDP 启动。

## 缓存和隐私

重启缓存最长保留 15 分钟，只包含展示通用额度所需的白名单字段：标准化的额度桶/窗口
标识、已用或剩余百分比、周期、重置时间戳和抓取时间戳。缓存绝不包含认证 Token、
邮箱、会话、DOM 内容、重置积分数值、展示标签或模型专属额度。

缓存复用会绑定到只根据 `auth.json` 文件元数据（`stat`）得到的本地认证上下文，不读取
文件内容。没有该上下文时不读写缓存；缓存过期、格式错误或上下文不匹配时会直接删除，
不会展示。完整边界见 [SECURITY.md](SECURITY.md)。

如需禁用持久缓存，请在启动进程环境或 Windows 用户环境变量中设置
`CODEX_QUOTA_DISABLE_CACHE=1`。下一次冷启动时，伴随进程会跳过缓存读写并删除已有额度
缓存。用户级环境变量只会被新进程继承，因此测试前应完全退出桌面应用。

## CDP 安全提醒

`127.0.0.1` 上的 CDP 对同一 Windows 用户运行的进程没有身份验证。同用户下的其他进程
可能发现随机端口，并在应用运行期间连接桌面渲染器。Store 软件包验证、监听进程归属
检查、固定 Browser 身份和受保护的 `app://` 渲染器探测，可以减少错误连接，但不能
消除此风险。

要关闭端点，请完全退出通过 CDP 启动的桌面应用，再从官方图标重新打开。只停止额度
伴随进程，不能移除已经传给桌面进程的启动参数。

## 开发

```powershell
npm.cmd run check
npm.cmd test
npm.cmd pack --dry-run
```

自动化测试只使用测试数据，不读取真实账号。真实账号检查只能通过主动执行
`doctor --live` 触发。

贡献代码前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)，维护者发布版本时请遵循
[docs/RELEASING.md](docs/RELEASING.md)。安全问题应按照 [SECURITY.md](SECURITY.md)
通过 GitHub Private Vulnerability Reporting 私下提交。

## 许可证

[MIT](LICENSE)

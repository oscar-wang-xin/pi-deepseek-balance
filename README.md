# pi-deepseek-balance

Pi 扩展：查询 **DeepSeek 账户余额** 与 **API 花费**，并在会话底部（footer）实时显示。

## 功能

- `/deepseek` 命令：查询余额 + 本次会话花费 + 全部会话累计（按模型分组的明细表）
- 会话底部实时显示：`DS 余额 ¥102.70 · 本会话 ¥0.0989`
  - 余额每 60 秒刷新一次（失败自动 15 秒后重试，显示"余额获取失败"提示）
  - 本会话花费在每轮对话结束后自动更新
  - **仅配置了 DeepSeek key 时才显示**
- LLM 可调用工具 `deepseek_balance`：可以直接说「帮我看看 DeepSeek 还剩多少钱」

## 安装

### 方式一：pi 包管理器（推荐，自动更新）

在 pi 的全局配置文件 `~/.pi/agent/settings.json`（Windows：`C:\Users\<用户名>\.pi\agent\settings.json`）中添加：

```json
{
  "packages": ["npm:pi-deepseek-balance"]
}
```

重启 pi（或执行 `/reload`）后自动安装生效。

也可以直接从 GitHub 安装：

```json
{
  "packages": ["git:github.com/oscar-wang-xin/pi-deepseek-balance"]
}
```

### 方式二：手动复制

将 `deepseek-balance.ts` 复制到全局扩展目录（或任意项目的 `.pi/extensions/`）：

- 全局：`~/.pi/agent/extensions/`
- 项目：`<项目>/.pi/extensions/`

重启 pi（或执行 `/reload`）后生效。

## 配置 DeepSeek Key

无需单独配置，自动使用 pi 的模型配置：

- `/login deepseek` 登录（推荐）
- 或设置环境变量 `DEEPSEEK_API_KEY`

未配置 key 时扩展不显示任何内容。

## 使用

```
/deepseek
```

或在对话中直接问：「帮我看看 DeepSeek 还剩多少钱」

## 卸载

- 方式一安装：从 `settings.json` 移除 `packages` 中的对应条目
- 方式二安装：删除复制过去的 `deepseek-balance.ts`

## 工作原理

| 数据 | 来源 |
|---|---|
| 账户余额 | DeepSeek 官方接口 `GET https://api.deepseek.com/user/balance` |
| API 花费 | pi 本地会话的 token 用量 × 模型计价（与官方价格一致） |

> 注意：DeepSeek 没有官方的用量明细接口，所以"花费"来自 pi 本地记录。

## 常见问题

**footer 显示"余额获取失败"？**
接口/网络暂时不可用，15 秒后会自动重试，无需处理。

**footer 不显示任何 DS 内容？**
未配置 DeepSeek key（见上文配置说明）。

**花费金额单位？**
人民币（¥）。DeepSeek 官方按 CNY 计价，pi 内置模型计价一致。

## License

MIT

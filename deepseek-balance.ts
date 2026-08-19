/**
 * DeepSeek 余额与花费查询扩展
 *
 * 安装：把本文件放在项目 `.pi/extensions/` 目录（或全局 `~/.pi/agent/extensions/`），
 * 然后重启 pi 或在会话里执行 `/reload`。
 *
 * 用法：
 *   /deepseek    —— 查询 DeepSeek 账户余额 + 本次会话/全部会话的 API 花费
 *
 * 会话底部实时显示：配置了 DeepSeek key 时，footer 会显示
 *   DS 余额 ¥xxx · 本会话 ¥x.xxx
 * 余额每 60 秒刷新一次，本会话花费在每一轮对话结束后刷新。
 * 未配置 DeepSeek key 时 footer 不显示任何内容。
 *
 * 同时注册了一个 LLM 可调用的工具 `deepseek_balance`，
 * 所以你也可以直接说「帮我看看 DeepSeek 还剩多少钱」。
 *
 * 数据来源：
 *   - 余额：DeepSeek 官方接口 GET https://api.deepseek.com/user/balance
 *   - 花费：pi 本地会话里的 token 用量与模型计价（与 DeepSeek 官方计价一致）
 *
 * Key 与 baseUrl：从 pi 的模型配置（auth.json / DEEPSEEK_API_KEY / models.json）
 * 自动获取，与模型调用共用同一份配置，无需单独设置。
 */

import { createReadStream } from "node:fs";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const PROVIDER = "deepseek";
const FETCH_TIMEOUT_MS = 10_000; // 余额接口请求超时
const MAX_SESSION_FILE_BYTES = 10 * 1024 * 1024; // 全会话统计时单个文件上限（10MB）

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

interface Totals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  tokens: number;
}

interface Breakdown extends Totals {
  byKey: Array<Totals & { key: string }>;
  files?: number;
}

interface BalanceReport {
  is_available: boolean;
  balance_infos: Array<{
    currency: string;
    total_balance: string;
    granted_balance: string;
    topped_up_balance: string;
  }>;
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

function emptyTotals(): Totals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, tokens: 0 };
}

function addUsage(t: Totals, u: any): void {
  // 数值防御：usage 字段异常（字符串/undefined）时按 0 处理，避免污染累计值
  const input = Number(u.input) || 0;
  const output = Number(u.output) || 0;
  const cacheRead = Number(u.cacheRead) || 0;
  const cacheWrite = Number(u.cacheWrite) || 0;
  t.input += input;
  t.output += output;
  t.cacheRead += cacheRead;
  t.cacheWrite += cacheWrite;
  t.cost += Number(u.cost?.total) || 0;
  t.tokens += input + output + cacheRead + cacheWrite;
}

/** 从一个 session entry 里提取可归属的用量（逻辑与 pi 内置 getUsageCostBreakdown 一致）。 */
function entryUsage(entry: any): { key: string; usage: any } | undefined {
  if (entry?.type === "message") {
    const m = entry.message;
    if (m?.role === "assistant" && m?.usage) {
      return {
        key: `${m.provider ?? "?"}/${m.responseModel ?? m.model ?? "?"}`,
        usage: m.usage,
      };
    }
    if (m?.role === "toolResult" && m?.usage) {
      return { key: "Tools/摘要", usage: m.usage };
    }
  }
  if ((entry?.type === "branch_summary" || entry?.type === "compaction") && entry?.usage) {
    return { key: "Tools/摘要", usage: entry.usage };
  }
  return undefined;
}

function finalizeBreakdown(total: Totals, byKey: Map<string, Totals>): Breakdown {
  const rows = [...byKey.entries()]
    .map(([key, t]) => ({ key, ...t }))
    .filter((r) => r.cost > 0 || r.tokens > 0)
    .sort((a, b) => b.cost - a.cost);
  return { ...total, byKey: rows };
}

function aggregate(entries: any[]): Breakdown {
  const byKey = new Map<string, Totals>();
  const total = emptyTotals();
  for (const e of entries) {
    const u = entryUsage(e);
    if (!u) continue;
    const t = byKey.get(u.key) ?? emptyTotals();
    addUsage(t, u.usage);
    byKey.set(u.key, t);
    addUsage(total, u.usage);
  }
  return finalizeBreakdown(total, byKey);
}

/** 流式统计单个 session 文件：逐行读取并聚合，不把整个文件载入内存。 */
async function aggregateFileStreaming(
  file: string,
  byKey: Map<string, Totals>,
  total: Totals,
): Promise<void> {
  try {
    const stream = createReadStream(file, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      const l = line.trim();
      if (!l) continue;
      let entry: any;
      try {
        entry = JSON.parse(l);
      } catch {
        continue; // 跳过损坏行
      }
      const u = entryUsage(entry);
      if (!u) continue;
      const t = byKey.get(u.key) ?? emptyTotals();
      addUsage(t, u.usage);
      byKey.set(u.key, t);
      addUsage(total, u.usage);
    }
  } catch {
    /* 文件不可读/读取中断 */
  }
}

/** 统计当前工作目录下所有 session 的累计用量。
 *  流式聚合：异步逐行处理，内存占用与文件总量无关，也不阻塞事件循环；
 *  跳过超大文件，避免命令/工具执行时撑爆内存或卡死 TUI。 */
async function aggregateAllSessions(sessionDir: string): Promise<Breakdown> {
  const byKey = new Map<string, Totals>();
  const total = emptyTotals();
  let files = 0;
  let names: string[];
  try {
    names = await fs.promises.readdir(sessionDir);
  } catch {
    return { ...total, byKey: [] as Array<Totals & { key: string }>, files: 0 };
  }
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const file = path.join(sessionDir, name);
    try {
      if ((await fs.promises.stat(file)).size > MAX_SESSION_FILE_BYTES) continue;
    } catch {
      continue; // 文件不可读/已删除
    }
    await aggregateFileStreaming(file, byKey, total);
    files++;
  }
  return { ...finalizeBreakdown(total, byKey), files };
}

/** 从 pi 模型配置读取 DeepSeek 的 key 与 baseUrl（与模型调用共用同一份配置）。 */
async function getDeepseekConfig(ctx: any): Promise<{ apiKey?: string; baseUrl?: string }> {
  const auth = await ctx.modelRegistry.getProviderAuth(PROVIDER);
  return {
    apiKey:
      (auth?.auth?.apiKey ? String(auth.auth.apiKey) : undefined) ??
      (process.env.DEEPSEEK_API_KEY || undefined),
    baseUrl: auth?.auth?.baseUrl ? String(auth.auth.baseUrl) : undefined,
  };
}

/** 由 baseUrl 推导余额接口地址（兼容带 /v1 的 OpenAI 兼容地址）。 */
function balanceEndpoint(baseUrl: string | undefined): string {
  const base = (baseUrl ?? "https://api.deepseek.com").replace(/\/+$/, "");
  return `${base.replace(/\/v\d+$/i, "")}/user/balance`;
}

async function fetchBalance(config: { apiKey?: string; baseUrl?: string }): Promise<BalanceReport> {
  const res = await fetch(balanceEndpoint(config.baseUrl), {
    headers: { Authorization: `Bearer ${config.apiKey}`, Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* ignore */
  }
  if (!res.ok) {
    const msg = json?.error?.message ?? text.slice(0, 300);
    throw new Error(`DeepSeek 余额接口返回 ${res.status}: ${msg}`);
  }
  return json as BalanceReport;
}

// ---------------------------------------------------------------------------
// 格式化
// ---------------------------------------------------------------------------

function fmtNum(n: number, digits = 0): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function fmtMoney(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const digits = Math.abs(n) < 0.01 ? 6 : 4;
  const s = n.toFixed(digits).replace(/\.?0+$/, "");
  return s === "" || s === "-0" ? "0" : s;
}

function currencySymbol(currency: string): string {
  if (currency === "USD") return "$";
  if (currency === "CNY") return "¥";
  return `${currency} `;
}

function formatUsageRows(title: string, breakdown: Breakdown): string {
  if (breakdown.tokens === 0 && breakdown.cost === 0) {
    return `### ${title}\n\n（暂无记录）\n`;
  }
  const lines: string[] = [
    `### ${title}`,
    ``,
    `| 模型 / 来源 | 花费 | 总 tokens | 输入 | 输出 | 缓存读 |`,
    `| --- | ---: | ---: | ---: | ---: | ---: |`,
  ];
  for (const r of breakdown.byKey) {
    lines.push(
      `| ${r.key} | ${fmtMoney(r.cost)} | ${fmtNum(r.tokens)} | ${fmtNum(r.input)} | ${fmtNum(r.output)} | ${fmtNum(r.cacheRead)} |`,
    );
  }
  lines.push(
    `| **合计** | **${fmtMoney(breakdown.cost)}** | **${fmtNum(breakdown.tokens)}** | ${fmtNum(breakdown.input)} | ${fmtNum(breakdown.output)} | ${fmtNum(breakdown.cacheRead)} |`,
  );
  return lines.join("\n") + "\n";
}

function formatBalance(balance: BalanceReport): string {
  const lines: string[] = ["### 账户余额", ""];
  const infos = balance.balance_infos ?? [];
  if (infos.length === 0) {
    lines.push("（余额接口未返回明细）");
  }
  for (const info of infos) {
    const unit = currencySymbol(info.currency);
    lines.push(`- 可用余额：**${unit}${info.total_balance}**`);
    lines.push(`- 充值余额：${unit}${info.topped_up_balance}`);
    lines.push(`- 赠金余额：${unit}${info.granted_balance}`);
  }
  lines.push("");
  lines.push(`余额是否可用：${balance.is_available ? "✅ 是" : "❌ 否"}`);
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// 会话底部（footer）实时显示
// ---------------------------------------------------------------------------

const FOOTER_KEY = "deepseek";
const BALANCE_REFRESH_MS = 60_000; // 余额轮询间隔（成功后）
const BALANCE_FAILURE_RETRY_MS = 15_000; // 余额获取失败后的快速重试间隔

const footerState: {
  enabled: boolean;
  /** 最近一次事件的有效 ctx。事件 ctx 每次都是新建的，不会 stale；
   *  轮询刷新统一用它，而不是捕获创建时的 ctx。 */
  currentCtx: any;
  /** 初始化锁：防止并发事件（如 session_start + turn_end）重复初始化出两个 timer。 */
  initPromise: Promise<void> | undefined;
  /** 用 setTimeout 链实现动态间隔轮询（成功 60s，失败 15s 快速重试）。 */
  timer: ReturnType<typeof setTimeout> | undefined;
  balanceText: string | undefined;
  /** 上次余额获取是否失败（失败时 footer 显示提示而不是静默消失）。 */
  balanceError: boolean;
  balanceInFlight: boolean; // 防重入：上次余额请求未完成时跳过
  /** 本次会话花费缓存：session 未变且 entry 数未变时复用，避免超大会话高频全量遍历。 */
  lastCost: { sessionId: string | undefined; count: number; cost: number };
} = {
  enabled: false,
  currentCtx: undefined,
  initPromise: undefined,
  timer: undefined,
  balanceText: undefined,
  balanceError: false,
  balanceInFlight: false,
  lastCost: { sessionId: undefined, count: -1, cost: 0 },
};

/** 从余额明细里选一条用于 footer：优先人民币账户，否则取第一条。 */
function pickBalanceText(balance: BalanceReport): string | undefined {
  const infos = balance.balance_infos ?? [];
  const info = infos.find((i) => i.currency === "CNY") ?? infos[0];
  if (!info) return undefined;
  return `${currencySymbol(info.currency)}${info.total_balance}`;
}

/** 首次进入时启用 footer；未配置 DeepSeek key 则保持禁用（不显示）。 */
async function ensureFooter(ctx: any): Promise<void> {
  footerState.currentCtx = ctx;
  if (footerState.enabled) return; // 已启用：只更新 ctx，不重复初始化（避免 timer 泄漏）
  if (footerState.initPromise) return footerState.initPromise;
  footerState.initPromise = (async () => {
    try {
      const config = await getDeepseekConfig(ctx);
      if (!config.apiKey) return; // 未配置 key → 不显示
      footerState.enabled = true;
      scheduleNextBalanceRefresh();
      void refreshBalance().catch(() => {});
      await refreshFooter(ctx);
    } catch {
      footerState.enabled = false; // 初始化失败则不显示
    }
  })();
  try {
    await footerState.initPromise;
  } finally {
    footerState.initPromise = undefined;
  }
}

/** 余额刷新调度：成功 60s 轮询，失败 15s 快速重试（网络抖动时尽快恢复显示）。 */
function scheduleNextBalanceRefresh(): void {
  if (!footerState.enabled) return; // 已停止则不再排程（防止 stopFooter 后残留 timer）
  if (footerState.timer) clearTimeout(footerState.timer);
  const delay = footerState.balanceError ? BALANCE_FAILURE_RETRY_MS : BALANCE_REFRESH_MS;
  footerState.timer = setTimeout(() => {
    if (!footerState.enabled) return;
    // catch 防御：任何未预料的 rejection 都不应变成未处理异常
    void refreshBalance().catch(() => {});
  }, delay);
}

/** 刷新余额（带防重入）。失败时标记 balanceError 并快速重试，成功恢复。
 *  注意：任何分支都不能提前 return 而跳过 scheduleNextBalanceRefresh，否则轮询链断裂。 */
async function refreshBalance(): Promise<void> {
  if (!footerState.enabled || footerState.balanceInFlight) return;
  footerState.balanceInFlight = true;
  try {
    const config = await getDeepseekConfig(footerState.currentCtx);
    if (config?.apiKey) {
      const balance = await fetchBalance(config);
      footerState.balanceText = pickBalanceText(balance);
      footerState.balanceError = false;
    } else {
      // key 临时不可用（如模型配置读取失败）：保留旧值并走快速重试，不断链
      footerState.balanceError = true;
    }
  } catch {
    footerState.balanceError = true; // 失败可见，不再静默吞掉
  } finally {
    footerState.balanceInFlight = false;
  }
  scheduleNextBalanceRefresh();
  await refreshFooter();
}

/** 用当前会话的花费 + 缓存的余额刷新 footer 文本。 */
async function refreshFooter(ctxOverride?: any): Promise<void> {
  if (!footerState.enabled) return;
  const ctx = ctxOverride ?? footerState.currentCtx;
  if (!ctx) return;
  try {
    // 花费缓存：session 未变且 entry 数未变时复用上次聚合结果（session 是 append-only，
    // 计数不变即无新记录；sessionId 保证切换 session 后不会误用旧值）
    let cost: number;
    try {
      const sessionId = ctx.sessionManager.getSessionId?.();
      const count = ctx.sessionManager.getEntries().length;
      const cached = footerState.lastCost;
      if (cached.sessionId === sessionId && cached.count === count) {
        cost = cached.cost;
      } else {
        cost = aggregate(ctx.sessionManager.getEntries()).cost;
        footerState.lastCost = { sessionId, count, cost };
      }
    } catch {
      cost = 0;
    }
    const parts: string[] = [];
    if (footerState.balanceText) {
      parts.push(`余额 ${footerState.balanceText}`);
    } else if (footerState.balanceError) {
      parts.push("余额获取失败"); // 失败可见：接口/网络问题时有提示
    }
    parts.push(`本会话 ¥${fmtMoney(cost)}`);
    ctx.ui.setStatus(FOOTER_KEY, `DS ${parts.join(" · ")}`);
  } catch {
    /* 计算异常或 ctx 已失效时忽略 */
  }
}

function stopFooter(): void {
  footerState.enabled = false;
  if (footerState.timer) clearTimeout(footerState.timer);
  footerState.timer = undefined;
  footerState.balanceText = undefined;
  footerState.balanceError = false;
  footerState.currentCtx = undefined;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function buildReport(ctx: any): Promise<{ markdown: string; summary: string }> {
  const config = await getDeepseekConfig(ctx);
  if (!config.apiKey) {
    throw new Error(
      "未找到 DeepSeek API Key。请先执行 /login deepseek 登录，或设置环境变量 DEEPSEEK_API_KEY。",
    );
  }

  const balance = await fetchBalance(config);
  const current = aggregate(ctx.sessionManager.getEntries());
  const all = await aggregateAllSessions(ctx.sessionManager.getSessionDir());

  const parts = [
    "# DeepSeek 账户",
    "",
    formatBalance(balance),
    formatUsageRows("本次会话花费", current),
    formatUsageRows(
      all.files != null ? `全部会话累计（当前目录 · ${all.files} 个会话）` : "全部会话累计",
      all,
    ),
    "> 花费金额按 pi 内置的 DeepSeek 模型计价计算，与 DeepSeek 官方价格一致。",
  ];

  const firstInfo = balance.balance_infos?.[0];
  const summary = firstInfo
    ? `DeepSeek 余额 ${currencySymbol(firstInfo.currency)}${firstInfo.total_balance}，全部会话累计花费 ¥${fmtMoney(all.cost)}`
    : `DeepSeek 全部会话累计花费 ¥${fmtMoney(all.cost)}`;

  return { markdown: parts.join("\n"), summary };
}

// ---------------------------------------------------------------------------
// 扩展入口
// ---------------------------------------------------------------------------

export default function deepseekBalanceExtension(pi: any): void {
  // 1) 斜杠命令：/deepseek
  pi.registerCommand("deepseek", {
    description: "查询 DeepSeek 账户余额与 API 花费",
    handler: async (_args: string, ctx: any) => {
      try {
        const { markdown, summary } = await buildReport(ctx);
        // 把报告写进会话记录，持久可见
        pi.sendMessage(
          {
            customType: "deepseek-balance",
            content: markdown,
            display: true,
          },
          { triggerTurn: false },
        );
        ctx.ui.notify(summary, "info");
      } catch (err: any) {
        ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
      }
    },
  });

  // 2) LLM 可调用工具：deepseek_balance（agent 可自行查询余额）
  pi.registerTool(
    defineTool({
      name: "deepseek_balance",
      label: "查询 DeepSeek 余额",
      description:
        "查询 DeepSeek API 账户的剩余余额，以及 pi 本地记录的 API 花费（token 用量与费用）。",
      promptSnippet: "deepseek_balance() — 查询 DeepSeek 账户余额与 API 花费",
      executionMode: "sequential", // 全会话扫描可能较慢，禁止与其它工具并行调用（防并发 IO/内存峰值）
      parameters: Type.Object({
        include_all_sessions: Type.Optional(
          Type.Boolean({
            description: "是否包含所有历史会话的累计花费",
            default: true,
          }),
        ),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        try {
          const config = await getDeepseekConfig(ctx);
          if (!config.apiKey) {
            return {
              content: [
                {
                  type: "text",
                  text: "未找到 DeepSeek API Key，请先通过 /login deepseek 登录。",
                },
              ],
              details: undefined,
            };
          }
          const balance = await fetchBalance(config);
          const current = aggregate(ctx.sessionManager.getEntries());
          const lines: string[] = [];
          for (const info of balance.balance_infos ?? []) {
            lines.push(
              `余额：${currencySymbol(info.currency)}${info.total_balance}（充值 ${currencySymbol(info.currency)}${info.topped_up_balance}，赠金 ${currencySymbol(info.currency)}${info.granted_balance}），可用=${balance.is_available}`,
            );
          }
          lines.push(`本次会话花费：¥${fmtMoney(current.cost)}（${fmtNum(current.tokens)} tokens）`);
          if (params.include_all_sessions !== false) {
            const all = await aggregateAllSessions(ctx.sessionManager.getSessionDir());
            lines.push(`全部会话累计花费：¥${fmtMoney(all.cost)}（${fmtNum(all.tokens)} tokens）`);
          }

          return {
            content: [{ type: "text", text: lines.join("\n") }],
            details: undefined,
          };
        } catch (err: any) {
          return {
            content: [
              {
                type: "text",
                text: `查询失败：${err instanceof Error ? err.message : String(err)}`,
              },
            ],
            details: undefined,
          };
        }
      },
    }),
  );

  // 3) 会话底部实时显示（仅配置了 DeepSeek key 时启用）
  // 事件 handler 收到的 ctx 每次都是新建的，因此每轮事件都更新 currentCtx，
  // 避免轮询闭包长期持有失效的 ctx（切换/新建/分支 session 后旧 ctx 会被 invalidate）。
  // 事件在 pi 中是串行 await 的，async handler + await 初始化使锁的生命周期稳定。
  const onSessionEvent = async (_event: any, ctx: any): Promise<void> => {
    footerState.currentCtx = ctx;
    await ensureFooter(ctx);
    await refreshFooter(ctx);
  };

  pi.on("session_start", onSessionEvent);
  pi.on("turn_end", onSessionEvent);
  pi.on("session_info_changed", onSessionEvent);
  pi.on("session_tree", onSessionEvent);
  pi.on("session_before_switch", onSessionEvent);
  pi.on("session_shutdown", async (_event: any, ctx: any) => {
    stopFooter();
    try {
      ctx.ui.setStatus(FOOTER_KEY, undefined);
    } catch {
      /* ignore */
    }
  });
}

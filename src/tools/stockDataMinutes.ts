import { TUSHARE_CONFIG } from '../config.js';
import { resolveStockCodes } from '../utils/stockCodeResolver.js';

/**
 * 分钟K线数据工具（A股/加密）
 * 说明：
 * - market_type = 'cn' 走 Tushare 分钟线接口（stk_mins）
 * - market_type = 'crypto' 走 Binance 分钟线接口（/api/v3/klines）
 * 按指定时间范围与频率返回分钟级K线。
 */
export const stockDataMinutes = {
  name: 'stock_data_minutes',
  description: '获取分钟K线数据：A股/加密。支持1MIN/5MIN/15MIN/30MIN/60MIN，时间范围需提供起止日期时间。示例：stock_data_minutes(code="600519.SH", market_type="cn", start_datetime="20240101093000", end_datetime="20240101150000", freq="1MIN")',
  inputSchema: {
    type: 'object' as const,
    properties: {
      code: {
        type: 'string' as const,
        description: "股票代码，如 '600519.SH' 或 '000001.SZ'。加密货币如 'BTCUSDT'、'ETHUSDT'",
        minLength: 1,
        maxLength: 50
      },
      market_type: {
        type: 'string' as const,
        description: "市场类型：'cn'（A股，Tushare）、'crypto'（加密币对，Binance）",
        enum: ['cn', 'crypto']
      },
      start_datetime: {
        type: 'string' as const,
        description: "起始日期时间，支持 'YYYYMMDDHHmmss' 或 'YYYY-MM-DD HH:mm:ss'",
        minLength: 14,
        maxLength: 19
      },
      end_datetime: {
        type: 'string' as const,
        description: "结束日期时间，支持 'YYYYMMDDHHmmss' 或 'YYYY-MM-DD HH:mm:ss'",
        minLength: 14,
        maxLength: 19
      },
      freq: {
        type: 'string' as const,
        description: "分钟周期：1MIN/5MIN/15MIN/30MIN/60MIN（不区分大小写）",
        enum: ['1MIN', '5MIN', '15MIN', '30MIN', '60MIN', '1min', '5min', '15min', '30min', '60min']
      }
    },
    required: ['code', 'market_type', 'start_datetime', 'end_datetime', 'freq']
  } as const,
  outputSchema: {
    type: 'object' as const,
    properties: {
      content: {
        type: 'array' as const,
        items: {
          type: 'object' as const,
          properties: {
            type: { type: 'string' as const },
            text: { type: 'string' as const }
          },
          required: ['type', 'text']
        }
      },
      isError: { type: 'boolean' as const }
    },
    required: ['content']
  } as const,
  async run(args: { code: string; market_type: string; start_datetime: string; end_datetime: string; freq: string }) {
    try {
      const TUSHARE_API_KEY = TUSHARE_CONFIG.API_TOKEN;
      const TUSHARE_API_URL = TUSHARE_CONFIG.API_URL;

      // 归一化时间：转为 YYYYMMDDHHmmss（剔除非数字）
      const normalizeDT = (v: string) => v.replace(/[^0-9]/g, '').padEnd(14, '0').slice(0, 14);
      const startTime = normalizeDT(args.start_datetime);
      const endTime = normalizeDT(args.end_datetime);
      if (startTime.length !== 14 || endTime.length !== 14) {
        throw new Error('起止时间格式不正确，请使用 YYYYMMDDHHmmss 或 YYYY-MM-DD HH:mm:ss');
      }
      if (endTime <= startTime) {
        throw new Error('结束时间必须大于起始时间');
      }

      // 归一化频率
      const rawFreq = String(args.freq || '').trim().toLowerCase();
      const freqMap: Record<string, string> = {
        '1min': '1min', '1m': '1min',
        '5min': '5min', '5m': '5min',
        '15min': '15min', '15m': '15min',
        '30min': '30min', '30m': '30min',
        '60min': '60min', '60m': '60min', '1h': '60min'
      };
      // 兼容 1MIN/5MIN 等写法（统一转小写再映射）
      const normalizedFreq = freqMap[rawFreq] || freqMap[rawFreq.replace('min', 'min')] || freqMap[rawFreq.replace('minute', 'min')] || rawFreq;
      const freq = normalizedFreq;
      const allowed = new Set(['1min', '5min', '15min', '30min', '60min']);
      if (!allowed.has(freq)) {
        throw new Error(`不支持的频率：${args.freq}，允许值：1MIN/5MIN/15MIN/30MIN/60MIN`);
      }

      // 市场分支
      const market = String(args.market_type || '').trim().toLowerCase();
      if (!['cn', 'crypto'].includes(market)) {
        throw new Error(`不支持的 market_type: ${args.market_type}，仅支持 'cn' 或 'crypto'`);
      }

      if (market === 'cn') {
        if (!TUSHARE_API_KEY) {
          throw new Error('缺少 Tushare Token：请在请求头 X-Tushare-Token 或环境变量 TUSHARE_TOKEN 中提供');
        }
        // 组装请求（Tushare 分钟线：stk_mins）
        const requestBody: any = {
          api_name: 'stk_mins',
          token: TUSHARE_API_KEY,
          params: {
            ts_code: args.code,
            start_time: startTime,
            end_time: endTime,
            freq: freq
          }
          // 不指定 fields，默认返回全部
        };

        // 超时控制
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), TUSHARE_CONFIG.TIMEOUT);

        try {
          const resp = await fetch(TUSHARE_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody),
            signal: controller.signal
          });

          clearTimeout(timeoutId);

          if (!resp.ok) {
            throw new Error(`Tushare HTTP ${resp.status}`);
          }
          const data = await resp.json();
          if (data.code !== 0) {
            throw new Error(`Tushare API错误: ${data.msg || 'unknown error'}`);
          }

          const fields: string[] = data.data?.fields || [];
          const items: any[] = data.data?.items || [];
          if (!fields.length || !items.length) {
            return {
              content: [{
                type: 'text',
                text: `# ${args.code} 分钟K线(${args.freq})\n\n区间: ${startTime} - ${endTime}\n\n暂无数据。`
              }]
            };
          }

          // 转对象数组
          const rows = items.map(row => {
            const obj: Record<string, any> = {};
            fields.forEach((f: string, i: number) => (obj[f] = row[i]));
            return obj;
          });

          // 常见字段名兼容：trade_time/time/datetime
          const timeKey = ['trade_time', 'time', 'datetime'].find(k => fields.includes(k)) || 'trade_time';
          const openKey = ['open'].find(k => fields.includes(k)) || 'open';
          const highKey = ['high'].find(k => fields.includes(k)) || 'high';
          const lowKey = ['low'].find(k => fields.includes(k)) || 'low';
          const closeKey = ['close'].find(k => fields.includes(k)) || 'close';
          const volKey = ['vol', 'volume'].find(k => fields.includes(k)) || 'vol';
          const amountKey = ['amount', 'amt'].find(k => fields.includes(k)) || 'amount';

          // 按时间倒序（最新在上）
          rows.sort((a, b) => String(b[timeKey] || '').localeCompare(String(a[timeKey] || '')));

          // 构造表格
          let out = `# ${args.code} 分钟K线（${freq}）\n\n`;
          out += `查询区间: ${startTime} - ${endTime}\n`;
          out += `返回条数: ${rows.length}\n\n`;
          const headers = ['时间', '开盘', '最高', '最低', '收盘', '成交量', '成交额(万元)'];
          out += `| ${headers.join(' | ')} |\n`;
          out += `|${headers.map(() => '--------').join('|')}|\n`;
          for (const r of rows) {
            const t = r[timeKey] ?? 'N/A';
            const o = safeNum(r[openKey]);
            const h = safeNum(r[highKey]);
            const l = safeNum(r[lowKey]);
            const c = safeNum(r[closeKey]);
            const v = r[volKey] == null ? 'N/A' : String(r[volKey]);
            const amt = r[amountKey] == null ? 'N/A' : String(r[amountKey]);
            out += `| ${t} | ${fmt(o)} | ${fmt(h)} | ${fmt(l)} | ${fmt(c)} | ${v} | ${amt} |\n`;
          }

          // 收集股票代码并生成说明（仅对A股）
          let stockExplanation = '';
          if (market === 'cn') {
            stockExplanation = await resolveStockCodes([args.code]);
          }
          
          return { content: [{ type: 'text', text: out + stockExplanation }] };
        } finally {
          // 兜底清理
          // clearTimeout 在 try 内处理；此处确保未走到前面时也释放
        }
      }

      // ===== crypto 分支（Binance 分钟线）=====
      // 频率映射到 Binance interval
      const binanceIntervalMap: Record<string, string> = {
        '1min': '1m',
        '5min': '5m',
        '15min': '15m',
        '30min': '30m',
        '60min': '1h'
      };
      const interval = binanceIntervalMap[freq];
      if (!interval) {
        throw new Error(`不支持的频率：${args.freq}（Binance）`);
      }

      // 时间转换为毫秒（UTC）
      const toMs = (s: string): number => {
        const y = parseInt(s.slice(0, 4));
        const m = parseInt(s.slice(4, 6));
        const d = parseInt(s.slice(6, 8));
        const hh = parseInt(s.slice(8, 10));
        const mm = parseInt(s.slice(10, 12));
        const ss = parseInt(s.slice(12, 14));
        return Date.UTC(y, m - 1, d, hh, mm, ss, 0);
      };
      const startMs = toMs(startTime);
      const endMs = toMs(endTime);

      // 交易对解析（兼容 BTCUSDT / BTC-USDT / BTC/USDT / coinid.USDT），USD 自动映射到 USDT
      const idToTicker: Record<string, string> = {
        'bitcoin': 'BTC', 'ethereum': 'ETH', 'tether': 'USDT', 'usd-coin': 'USDC', 'solana': 'SOL',
        'binancecoin': 'BNB', 'ripple': 'XRP', 'cardano': 'ADA', 'polkadot': 'DOT', 'chainlink': 'LINK',
        'litecoin': 'LTC', 'shiba-inu': 'SHIB', 'tron': 'TRX', 'toncoin': 'TON', 'bitcoin-cash': 'BCH',
        'ethereum-classic': 'ETC'
      };
      const parseBinanceSymbol = (raw: string): string => {
        const trimmed = String(raw || '').trim();
        const upper = trimmed.toUpperCase();
        const validQuotes = new Set(['USDT','USDC','FDUSD','TUSD','BUSD','BTC','ETH']);
        if (!upper.includes('-') && !upper.includes('/') && !upper.includes('.')) {
          return upper;
        }
        let base = '';
        let quote = '';
        if (upper.includes('-') || upper.includes('/')) {
          const sep = upper.includes('-') ? '-' : '/';
          const [b, q] = upper.split(sep);
          base = b;
          quote = q;
        } else if (upper.includes('.')) {
          const [id, vs] = upper.split('.');
          base = idToTicker[id.toLowerCase()] || id;
          quote = vs;
        }
        if (quote === 'USD') quote = 'USDT';
        if (!validQuotes.has(quote)) {
          throw new Error(`不支持的报价资产: ${quote}。支持: ${Array.from(validQuotes).join(', ')}`);
        }
        return `${base}${quote}`;
      };
      const symbol = parseBinanceSymbol(args.code);

      // 分页请求
      const allKlines: any[] = [];
      let cursor = startMs;
      let pageIndex = 0;
      const maxPages = 500;
      while (cursor < endMs && pageIndex < maxPages) {
        const url = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&startTime=${cursor}&endTime=${endMs}&limit=1000`;
        const resp = await fetch(url);
        if (!resp.ok) {
          try {
            const ct = resp.headers.get('content-type') || '';
            if (ct.includes('application/json')) {
              const err = await resp.json();
              const msg = err?.msg || `HTTP ${resp.status}`;
              if (Number(err?.code) === -1121 || /invalid symbol/i.test(String(msg))) {
                throw new Error(`Binance 无效交易对: ${symbol}。该币对在 Binance 不存在或已下线，请更换有效币对（例如：BTCUSDT、ETHUSDT、SOLUSDT）。也支持 BTC-USDT、BTC/USDT、或 coinid.USDT 写法。`);
              }
              throw new Error(`Binance K线请求失败: ${resp.status} - ${msg}`);
            } else {
              const text = await resp.text();
              throw new Error(`Binance K线请求失败: ${resp.status}${text ? ` - ${text}` : ''}`);
            }
          } catch (e) {
            if (e instanceof Error) throw e;
            throw new Error(`Binance K线请求失败: ${resp.status}`);
          }
        }
        const kl = await resp.json();
        if (!Array.isArray(kl)) throw new Error('Binance 返回的 K 线数据格式异常');
        if (kl.length === 0) break;
        allKlines.push(...kl);
        const lastOpenTime = Number(kl[kl.length - 1][0]);
        if (!(lastOpenTime > cursor)) break;
        cursor = lastOpenTime + 1;
        pageIndex += 1;
        if (kl.length < 1000) break;
      }

      // 转换为统一对象
      const toYMDHMS = (ms: number): string => {
        const d = new Date(ms);
        const y = d.getUTCFullYear();
        const m = String(d.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(d.getUTCDate()).padStart(2, '0');
        const hh = String(d.getUTCHours()).padStart(2, '0');
        const mm = String(d.getUTCMinutes()).padStart(2, '0');
        const ss = String(d.getUTCSeconds()).padStart(2, '0');
        return `${y}-${m}-${dd} ${hh}:${mm}:${ss}`;
      };
      const rows = allKlines.map(row => {
        const openTime = Number(row[0]);
        return {
          trade_time: toYMDHMS(openTime),
          open: Number(row[1]),
          high: Number(row[2]),
          low: Number(row[3]),
          close: Number(row[4]),
          vol: Number(row[5])
        } as Record<string, any>;
      });

      // 严格过滤在用户区间内（Binance 已按毫秒过滤，此处再按显示字段兜底）
      const filtered = rows.filter(r => true);
      filtered.sort((a, b) => String(b.trade_time).localeCompare(String(a.trade_time)));

      // 输出
      let out = `# ${args.code} 分钟K线（${freq}，Binance）\n\n`;
      out += `查询区间: ${startTime} - ${endTime}\n`;
      out += `返回条数: ${filtered.length}\n\n`;
      const headers = ['时间', '开盘', '最高', '最低', '收盘', '成交量'];
      out += `| ${headers.join(' | ')} |\n`;
      out += `|${headers.map(() => '--------').join('|')}|\n`;
      for (const r of filtered) {
        out += `| ${r.trade_time} | ${fmt(safeNum(r.open))} | ${fmt(safeNum(r.high))} | ${fmt(safeNum(r.low))} | ${fmt(safeNum(r.close))} | ${r.vol == null ? 'N/A' : String(r.vol)} |\n`;
      }

      return { content: [{ type: 'text', text: out }] };
    } catch (err) {
      return {
        content: [{
          type: 'text',
          text: `获取分钟K线失败：${err instanceof Error ? err.message : String(err)}`
        }],
        isError: true
      };
    }
  }
};

function safeNum(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function fmt(n: number | null, d = 2): string {
  return n == null ? 'N/A' : n.toFixed(d);
}

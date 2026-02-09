import { TUSHARE_CONFIG } from '../config.js';
import { resolveStockCodes, extractStockCodes } from '../utils/stockCodeResolver.js';

export const dragonTigerInst = {
  name: 'dragon_tiger_inst',
  description: '获取龙虎榜机构成交明细。示例：dragonTigerInst(trade_date="20240101", ts_code="000001.SZ")',
  inputSchema: {
    type: 'object' as const,
    properties: {
      trade_date: {
        type: 'string' as const,
        description: '交易日期，格式YYYYMMDD',
        pattern: "^[0-9]{8}$",
        minLength: 8,
        maxLength: 8
      },
      ts_code: {
        type: 'string' as const,
        description: '可选，股票TS代码，如 000001.SZ',
        minLength: 1,
        maxLength: 20
      }
    },
    required: ['trade_date']
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
  async run(args: { trade_date: string; ts_code?: string }) {
    try {
      if (!args.trade_date || args.trade_date.trim().length !== 8) {
        throw new Error('trade_date 必须为YYYYMMDD');
      }

      if (!TUSHARE_CONFIG.API_TOKEN) {
        throw new Error('请配置TUSHARE_TOKEN环境变量');
      }

      const params: any = {
        api_name: 'top_inst',
        token: TUSHARE_CONFIG.API_TOKEN,
        params: {
          trade_date: args.trade_date
        }
      };
      if (args.ts_code) params.params.ts_code = args.ts_code;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TUSHARE_CONFIG.TIMEOUT);
      try {
        const resp = await fetch(TUSHARE_CONFIG.API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(params),
          signal: controller.signal
        });
        if (!resp.ok) throw new Error(`Tushare API请求失败: ${resp.status}`);
        const data = await resp.json();
        if (data.code !== 0) throw new Error(`Tushare API错误: ${data.msg}`);

        const fields: string[] = data.data?.fields ?? [];
        const items: any[] = data.data?.items ?? [];
        if (items.length === 0) {
          return {
            content: [
              { type: 'text', text: `# 龙虎榜机构明细 ${args.trade_date}${args.ts_code ? ` - ${args.ts_code}` : ''}\n\n暂无数据` }
            ]
          };
        }

        // 字段顺序按需求固定（移除 trade_date 列）
        const desired = ['ts_code','exalter','buy','buy_rate','sell','sell_rate','net_buy','reason'];
        const headers = desired.filter(h => fields.includes(h));

        let table = `| ${headers.join(' | ')} |\n`;
        table += `|${headers.map(() => '--------').join('|')}|\n`;
        let totalBuy = 0;
        let totalSell = 0;
        let totalNet = 0;
        for (const row of items) {
          const obj: Record<string, any> = {};
          fields.forEach((f: string, idx: number) => obj[f] = row[idx]);
          const line = headers.map(h => {
            const v = obj[h];
            return (v === null || v === undefined || v === '') ? 'N/A' : String(v);
          });
          table += `| ${line.join(' | ')} |\n`;
          const buyVal = Number(obj.buy);
          const sellVal = Number(obj.sell);
          const netVal = Number(obj.net_buy);
          if (!isNaN(buyVal)) totalBuy += buyVal;
          if (!isNaN(sellVal)) totalSell += sellVal;
          if (!isNaN(netVal)) totalNet += netVal;
        }

        const title = `# 龙虎榜机构明细 ${args.trade_date}${args.ts_code ? ` - ${args.ts_code}` : ''}`;
        const fmt = (n: number) => n.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
        const summary = `\n\n## 当日资金统计\n- 买入额合计: ${fmt(totalBuy)} 元\n- 卖出额合计: ${fmt(totalSell)} 元\n- 净流入: ${fmt(totalNet)} 元`;
        
        // 收集所有股票代码并生成说明
        const stockCodes: string[] = [];
        for (const row of items) {
          const obj: Record<string, any> = {};
          fields.forEach((f: string, idx: number) => obj[f] = row[idx]);
          if (obj.ts_code) {
            stockCodes.push(String(obj.ts_code));
          }
        }
        const stockExplanation = await resolveStockCodes(stockCodes);
        
        return { content: [ { type: 'text', text: `${title}\n\n${table}${summary}${stockExplanation}` } ] };
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error) {
      return {
        content: [ { type: 'text', text: `❌ 查询失败: ${error instanceof Error ? error.message : String(error)}` } ],
        isError: true
      };
    }
  }
};



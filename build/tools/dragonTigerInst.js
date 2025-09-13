import { TUSHARE_CONFIG } from '../config.js';
export const dragonTigerInst = {
    name: 'dragon_tiger_inst',
    description: '龙虎榜机构成交明细（top_inst）。必填：交易日期；可选：股票TS代码。返回表格包含买入/卖出/净额及上榜理由等。',
    parameters: {
        type: 'object',
        properties: {
            trade_date: {
                type: 'string',
                description: '交易日期，格式YYYYMMDD'
            },
            ts_code: {
                type: 'string',
                description: '可选，股票TS代码，如 000001.SZ'
            }
        },
        required: ['trade_date']
    },
    async run(args) {
        try {
            if (!args.trade_date || args.trade_date.trim().length !== 8) {
                throw new Error('trade_date 必须为YYYYMMDD');
            }
            if (!TUSHARE_CONFIG.API_TOKEN) {
                throw new Error('请配置TUSHARE_TOKEN环境变量');
            }
            const params = {
                api_name: 'top_inst',
                token: TUSHARE_CONFIG.API_TOKEN,
                params: {
                    trade_date: args.trade_date
                }
            };
            if (args.ts_code)
                params.params.ts_code = args.ts_code;
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), TUSHARE_CONFIG.TIMEOUT);
            try {
                const resp = await fetch(TUSHARE_CONFIG.API_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(params),
                    signal: controller.signal
                });
                if (!resp.ok)
                    throw new Error(`Tushare API请求失败: ${resp.status}`);
                const data = await resp.json();
                if (data.code !== 0)
                    throw new Error(`Tushare API错误: ${data.msg}`);
                const fields = data.data?.fields ?? [];
                const items = data.data?.items ?? [];
                if (items.length === 0) {
                    return {
                        content: [
                            { type: 'text', text: `# 龙虎榜机构明细 ${args.trade_date}${args.ts_code ? ` - ${args.ts_code}` : ''}\n\n暂无数据` }
                        ]
                    };
                }
                // 字段顺序按需求固定（移除 trade_date 列）
                const desired = ['ts_code', 'exalter', 'buy', 'buy_rate', 'sell', 'sell_rate', 'net_buy', 'reason'];
                const headers = desired.filter(h => fields.includes(h));
                let table = `| ${headers.join(' | ')} |\n`;
                table += `|${headers.map(() => '--------').join('|')}|\n`;
                let totalBuy = 0;
                let totalSell = 0;
                let totalNet = 0;
                for (const row of items) {
                    const obj = {};
                    fields.forEach((f, idx) => obj[f] = row[idx]);
                    const line = headers.map(h => {
                        const v = obj[h];
                        return (v === null || v === undefined || v === '') ? 'N/A' : String(v);
                    });
                    table += `| ${line.join(' | ')} |\n`;
                    const buyVal = Number(obj.buy);
                    const sellVal = Number(obj.sell);
                    const netVal = Number(obj.net_buy);
                    if (!isNaN(buyVal))
                        totalBuy += buyVal;
                    if (!isNaN(sellVal))
                        totalSell += sellVal;
                    if (!isNaN(netVal))
                        totalNet += netVal;
                }
                const title = `# 龙虎榜机构明细 ${args.trade_date}${args.ts_code ? ` - ${args.ts_code}` : ''}`;
                const fmt = (n) => n.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
                const summary = `\n\n## 当日资金统计\n- 买入额合计: ${fmt(totalBuy)} 元\n- 卖出额合计: ${fmt(totalSell)} 元\n- 净流入: ${fmt(totalNet)} 元`;
                return { content: [{ type: 'text', text: `${title}\n\n${table}${summary}` }] };
            }
            finally {
                clearTimeout(timeoutId);
            }
        }
        catch (error) {
            return {
                content: [{ type: 'text', text: `❌ 查询失败: ${error instanceof Error ? error.message : String(error)}` }],
                isError: true
            };
        }
    }
};
//# sourceMappingURL=dragonTigerInst.js.map
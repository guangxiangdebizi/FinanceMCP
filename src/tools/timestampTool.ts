export const timestampTool = {
  name: "current_timestamp",
  description: "获取当前东八区（中国时区）的时间戳，包括年月日时分秒信息",
  parameters: {
    type: "object",
    properties: {
      format: {
        type: "string",
        description: "时间格式，可选值：datetime(完整日期时间，默认)、date(仅日期)、time(仅时间)、timestamp(Unix时间戳)、readable(可读格式)"
      }
    }
  },
  async run(args?: { format?: string }) {
    const now = new Date();
    const chinaTime = new Date(now.getTime() + (8 * 60 * 60 * 1000));
    const format = args?.format || 'datetime';
    const pad = (n: number) => n.toString().padStart(2, '0');
    const y = chinaTime.getUTCFullYear();
    const m = pad(chinaTime.getUTCMonth() + 1);
    const d = pad(chinaTime.getUTCDate());
    const hh = pad(chinaTime.getUTCHours());
    const mm = pad(chinaTime.getUTCMinutes());
    const ss = pad(chinaTime.getUTCSeconds());
    const weekdays = ['星期日','星期一','星期二','星期三','星期四','星期五','星期六'];
    const wd = weekdays[chinaTime.getUTCDay()];
    let result = `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
    if (format === 'date') result = `${y}-${m}-${d}`;
    if (format === 'time') result = `${hh}:${mm}:${ss}`;
    if (format === 'timestamp') result = Math.floor(chinaTime.getTime() / 1000).toString();
    if (format === 'readable') result = `${y}年${m}月${d}日 ${wd} ${hh}时${mm}分${ss}秒`;
    return {
      content: [{ type: 'text', text: `## 🕐 当前东八区时间\n\n格式: ${format}\n时间: ${result}\n星期: ${wd}` }]
    };
  }
};

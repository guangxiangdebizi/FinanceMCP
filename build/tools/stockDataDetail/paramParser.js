// 技术指标参数解析器模块
/**
 * 解析技术指标参数
 * @param indicator 指标字符串，例如 "macd(12,26,9)" 或 "rsi"
 * @returns 解析后的指标名称和参数
 */
export function parseIndicatorParams(indicator) {
    const match = indicator.match(/^([a-zA-Z]+\d*)(\(([^)]+)\))?$/);
    if (!match) {
        throw new Error(`无效的技术指标格式: ${indicator}`);
    }
    const name = match[1].toLowerCase();
    const paramsStr = match[3];
    let params = [];
    if (paramsStr) {
        params = paramsStr.split(',').map(p => {
            const num = parseFloat(p.trim());
            if (isNaN(num)) {
                throw new Error(`技术指标${name}的参数必须是数字: ${p}`);
            }
            return num;
        });
    }
    return { name, params };
}
/**
 * 格式化指标参数用于显示
 * @param name 指标名称
 * @param params 参数数组
 * @returns 格式化的参数字符串
 */
export function formatIndicatorParams(name, params) {
    return params.length > 0 ? `(${params.join(',')})` : '(默认)';
}
//# sourceMappingURL=paramParser.js.map
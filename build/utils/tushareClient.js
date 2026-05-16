import { TUSHARE_CONFIG } from '../config.js';
/**
 * Shared Tushare API caller used by V2 branches.
 * Handles timeout, HTTP errors, quota errors, and field-to-object mapping.
 */
export async function callTushare(apiName, params, fields) {
    const apiKey = TUSHARE_CONFIG.API_TOKEN;
    const apiUrl = TUSHARE_CONFIG.API_URL;
    if (!apiKey)
        throw new Error('请配置TUSHARE_TOKEN环境变量');
    const body = { api_name: apiName, token: apiKey, params };
    if (fields)
        body.fields = fields;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TUSHARE_CONFIG.TIMEOUT);
    try {
        console.log(`请求Tushare API: ${apiName}，参数:`, params);
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        if (!response.ok)
            throw new Error(`Tushare API请求失败: ${response.status}`);
        const json = await response.json();
        if (json.code !== 0) {
            const rawMsg = json.msg || '';
            const hitQuota = /(权限|积分|次数|频次|每天|每日|试用|超出)/i.test(rawMsg);
            if (hitQuota) {
                throw new Error(`Tushare API 访问受限（接口：${apiName}）：${rawMsg}。\n` +
                    `提示：该接口对积分有门槛，未达标时每日仅能试用少数几次。` +
                    `请在 https://tushare.pro 查看接口所需积分并提升权限后重试。`);
            }
            throw new Error(`Tushare API错误 (${apiName}): ${rawMsg}`);
        }
        if (!json.data || !json.data.items) {
            throw new Error(`接口 ${apiName} 未返回数据`);
        }
        const resultFields = json.data.fields;
        const data = json.data.items.map((item) => {
            const row = {};
            resultFields.forEach((f, i) => { row[f] = item[i]; });
            return row;
        });
        console.log(`成功获取到${data.length}条记录 (${apiName})`);
        return { data, fields: resultFields };
    }
    finally {
        clearTimeout(timeoutId);
    }
}

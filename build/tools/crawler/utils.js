// 检查是否包含关键词（OR逻辑）
export function containsKeywords(text, keywords) {
    if (keywords.length === 0)
        return true;
    const lowerText = text.toLowerCase();
    return keywords.some(keyword => lowerText.includes(keyword.toLowerCase().trim()));
}
// 去重
export function removeDuplicates(news) {
    const seen = new Set();
    return news.filter(item => {
        const key = item.title + item.source;
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
}
// 格式化时间
export function formatTime(timeStr) {
    if (!timeStr)
        return new Date().toISOString();
    // 处理各种时间格式
    if (timeStr.includes('-') || timeStr.includes('/')) {
        return new Date(timeStr).toISOString();
    }
    // 处理时间戳
    if (/^\d+$/.test(timeStr)) {
        const timestamp = parseInt(timeStr);
        // 如果是10位时间戳，转换为13位
        const ts = timestamp.toString().length === 10 ? timestamp * 1000 : timestamp;
        return new Date(ts).toISOString();
    }
    return new Date().toISOString();
}
//# sourceMappingURL=utils.js.map
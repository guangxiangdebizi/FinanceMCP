// 通用数据格式化函数模块
// 用于处理通用的数据展示
// 格式化通用数据
export function formatGenericData(data, fields) {
    let output = '';
    for (const item of data) {
        output += ' 数据记录\n';
        for (const field of fields.slice(0, 10)) { // 只显示前10个字段
            if (item[field] !== null && item[field] !== undefined) {
                output += `${field}: ${item[field]}\n`;
            }
        }
        output += '\n';
    }
    return output;
}
//# sourceMappingURL=genericFormatters.js.map
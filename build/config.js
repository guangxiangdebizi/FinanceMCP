import * as dotenv from 'dotenv';
// 加载环境变量：
// 1. 本地开发时，从.env文件加载
// 2. 在Smithery部署时，从配置文件中加载
dotenv.config();
// For logging purposes only in development
if (process.env.NODE_ENV !== 'production') {
    console.log('Environment variables loaded, TUSHARE_TOKEN available:', process.env.TUSHARE_TOKEN ? 'Yes' : 'No');
}
export const TUSHARE_CONFIG = {
    /**
     * Tushare API Token
     * 1. 本地开发：在项目根目录创建.env文件并设置 TUSHARE_TOKEN=你的token值
     * 2. Smithery部署：在Smithery平台配置TUSHARE_TOKEN
     */
    API_TOKEN: process.env.TUSHARE_TOKEN ?? "",
    /** Tushare 服务器地址 */
    API_URL: "https://api.tushare.pro",
    /** 超时 ms */
    TIMEOUT: 30000,
};

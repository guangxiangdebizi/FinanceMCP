import { TUSHARE_CONFIG } from '../config.js';
import { formatHkIncomeData } from './companyPerformanceDetail_hk/hkIncomeFormatters.js';
import { formatHkBalanceData } from './companyPerformanceDetail_hk/hkBalanceFormatters.js';
import { formatHkCashflowData } from './companyPerformanceDetail_hk/hkCashflowFormatters.js';

export const companyPerformance_hk = {
  name: "company_performance_hk",
  description: "获取港股公司财务数据。示例：companyPerformance_hk(ts_code='00700.HK', data_type='income', start_date='20230101', end_date='20231231')",
  inputSchema: {
    type: "object" as const,
    properties: {
      ts_code: {
        type: "string" as const,
        description: "港股代码，如'00700.HK'表示腾讯控股，'00939.HK'表示建设银行",
        minLength: 1,
        maxLength: 20
      },
      data_type: {
        type: "string" as const,
        description: "数据类型：income(利润表)、balance(资产负债表)、cashflow(现金流量表)",
        enum: ["income", "balance", "cashflow"]
      },
      start_date: {
        type: "string" as const,
        description: "起始日期，格式为YYYYMMDD，如'20230101'",
        pattern: "^[0-9]{8}$",
        minLength: 8,
        maxLength: 8
      },
      end_date: {
        type: "string" as const,
        description: "结束日期，格式为YYYYMMDD，如'20231231'",
        pattern: "^[0-9]{8}$",
        minLength: 8,
        maxLength: 8
      },
      period: {
        type: "string" as const,
        description: "特定报告期，格式为YYYYMMDD，如'20231231'表示2023年年报。指定此参数时将忽略start_date和end_date",
        pattern: "^[0-9]{8}$",
        minLength: 8,
        maxLength: 8
      },
      ind_name: {
        type: "string" as const,
        description: "指定财务科目名称，如'营业额'、'毛利'、'除税后溢利'等，不指定则返回全部科目",
        minLength: 1,
        maxLength: 50
      }
    },
    required: ["ts_code", "data_type", "start_date", "end_date"]
  } as const,
  outputSchema: {
    type: "object" as const,
    properties: {
      content: {
        type: "array" as const,
        items: {
          type: "object" as const,
          properties: {
            type: { type: "string" as const },
            text: { type: "string" as const }
          },
          required: ["type", "text"]
        }
      },
      isError: { type: "boolean" as const }
    },
    required: ["content"]
  } as const,
  async run(args: { 
    ts_code: string; 
    data_type: string; 
    start_date: string;
    end_date: string;
    period?: string;
    ind_name?: string;
  }) {
    try {
      
      const TUSHARE_API_KEY = TUSHARE_CONFIG.API_TOKEN;
      const TUSHARE_API_URL = TUSHARE_CONFIG.API_URL;
      
      if (!TUSHARE_API_KEY) {
        throw new Error('请配置TUSHARE_TOKEN环境变量');
      }

      // 根据data_type选择对应的接口
      let apiInterface = '';
      let formatFunction: any = null;
      
      switch (args.data_type) {
        case 'income':
          apiInterface = 'hk_income';
          formatFunction = formatHkIncomeData;
          break;
        case 'balance':
          apiInterface = 'hk_balancesheet';
          formatFunction = formatHkBalanceData;
          break;
        case 'cashflow':
          apiInterface = 'hk_cashflow';
          formatFunction = formatHkCashflowData;
          break;
        default:
          throw new Error(`不支持的数据类型: ${args.data_type}`);
      }

      const result = await fetchHkFinancialData(
        apiInterface,
        args.ts_code,
        args.period,
        args.start_date,
        args.end_date,
        args.ind_name,
        TUSHARE_API_KEY,
        TUSHARE_API_URL
      );

      if (!result.data || result.data.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `# ${args.ts_code} 港股${getDataTypeName(args.data_type)}数据\n\n❌ 未找到相关数据，请检查股票代码或日期范围`
            }
          ]
        };
      }

      // 使用对应的格式化函数
      if (formatFunction) {
        const formattedResult = formatFunction(result.data, args.ts_code, args.data_type);
        return formattedResult;
      } else {
        // 如果没有实现格式化器，返回原始数据
        return {
          content: [
            {
              type: "text",
              text: `# ${args.ts_code} 港股${getDataTypeName(args.data_type)}数据\n\n⚠️ 格式化器待实现，以下为原始数据：\n\n${JSON.stringify(result.data, null, 2)}`
            }
          ]
        };
      }

    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `❌ 港股公司业绩查询失败: ${error instanceof Error ? error.message : String(error)}`
          }
        ],
        isError: true
      };
    }
  }
};

// 获取数据类型中文名称
function getDataTypeName(dataType: string): string {
  const names: { [key: string]: string } = {
    'income': '利润表',
    'balance': '资产负债表',
    'cashflow': '现金流量表'
  };
  return names[dataType] || dataType;
}

// 通用的港股财务数据获取函数
async function fetchHkFinancialData(
  apiInterface: string,
  ts_code: string,
  period?: string,
  start_date?: string,
  end_date?: string,
  ind_name?: string,
  apiKey?: string,
  apiUrl?: string
): Promise<any> {
  const requestData: any = {
    api_name: apiInterface,
    token: apiKey,
    params: {
      ts_code: ts_code
    }
  };

  // 根据是否指定period来设置参数
  if (period) {
    requestData.params.period = period;
  } else if (start_date && end_date) {
    requestData.params.start_date = start_date;
    requestData.params.end_date = end_date;
  }

  // 如果指定了具体的财务科目
  if (ind_name) {
    requestData.params.ind_name = ind_name;
  }

  const response = await fetch(apiUrl!, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(requestData),
    signal: AbortSignal.timeout(TUSHARE_CONFIG.TIMEOUT)
  });

  if (!response.ok) {
    throw new Error(`Tushare API请求失败: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  
  if (data.code !== 0) {
    throw new Error(`Tushare API错误: ${data.msg || '未知错误'}`);
  }

  // 将返回的数组格式转换为对象数组
  const items: any[] = [];
  if (data.data && data.data.items && data.data.items.length > 0) {
    const fields = data.data.fields;
    for (const item of data.data.items) {
      const obj: any = {};
      fields.forEach((field: string, index: number) => {
        obj[field] = item[index];
      });
      items.push(obj);
    }
  }

  return { data: items };
} 
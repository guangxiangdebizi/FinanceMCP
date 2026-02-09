import { TUSHARE_CONFIG } from '../config.js';
import {
  formatBasicBalance,
  formatAllBalance
} from './companyPerformanceDetail/balanceFormatters.js';
import {
  formatBasicCashFlow,
  formatCashflowAll
} from './companyPerformanceDetail/cashflowFormatters.js';
import {
  formatBasicIncome,
  formatAllIncome
} from './companyPerformanceDetail/incomeFormatters.js';
import {
  formatIndicators
} from './companyPerformanceDetail/indicatorsFormatters.js';
import { formatForecast, formatExpress } from './companyPerformanceDetail/forecastExpressFormatters.js';
import { formatDividend } from './companyPerformanceDetail/dividendFormatters.js';
import { formatMainBusiness, formatMainBusinessCombined } from './companyPerformanceDetail/businessFormatters.js';
import { formatHolderNumber, formatHolderTrade } from './companyPerformanceDetail/holderFormatters.js';
import { formatGenericData } from './companyPerformanceDetail/genericFormatters.js';
import { formatAudit } from './companyPerformanceDetail/auditFormatters.js';
import { formatManagement } from './companyPerformanceDetail/managementFormatters.js';
import { formatCompanyBasic } from './companyPerformanceDetail/companyBasicFormatters.js';
import { formatShareFloat } from './companyPerformanceDetail/shareFloatFormatters.js';
import { formatRepurchase } from './companyPerformanceDetail/repurchaseFormatters.js';
import { formatTop10Holders, formatTop10FloatHolders } from './companyPerformanceDetail/top10HoldersFormatters.js';
import { formatPledgeStat, formatPledgeDetail } from './companyPerformanceDetail/pledgeFormatters.js';

export const companyPerformance = {
  name: "company_performance",
  description: "获取上市公司综合表现数据，包括业绩预告、业绩快报、财务指标、分红送股、主营业务构成、股东变动数据、管理层信息、公司基本信息、资产负债表、现金流量表、利润表等完整财务报表数据。示例：company_performance(ts_code='000001.SZ', data_type='indicators', start_date='20240101', end_date='20240131')",
  inputSchema: {
    type: "object" as const,
    properties: {
      ts_code: {
        type: "string" as const,
        description: "股票代码，如'000001.SZ'表示平安银行，'600000.SH'表示浦发银行",
        pattern: "^[0-9]{6}\\.(SZ|SH)$",
        minLength: 9,
        maxLength: 9
      },
      data_type: {
        type: "string" as const,
        description: "数据类型：forecast(业绩预告)、express(业绩快报)、indicators(财务指标)、dividend(分红送股)、mainbz(主营业务构成)、holder_number(股东人数)、holder_trade(股东增减持)、managers(管理层信息)、audit(财务审计意见)、company_basic(公司基本信息)、balance_basic(核心资产负债表)、balance_all(完整资产负债表)、cashflow_basic(基础现金流)、cashflow_all(完整现金流)、income_basic(核心利润表)、income_all(完整利润表)、share_float(限售股解禁)、repurchase(股票回购)、top10_holders(前十大股东)、top10_floatholders(前十大流通股东)、pledge_stat(股权质押统计)、pledge_detail(股权质押明细)",
        enum: ["forecast", "express", "indicators", "dividend", "mainbz", "holder_number", "holder_trade", "managers", "audit", "company_basic", "balance_basic", "balance_all", "cashflow_basic", "cashflow_all", "income_basic", "income_all", "share_float", "repurchase", "top10_holders", "top10_floatholders", "pledge_stat", "pledge_detail"]
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
  }) {
    try {
      
      const TUSHARE_API_KEY = TUSHARE_CONFIG.API_TOKEN;
      const TUSHARE_API_URL = TUSHARE_CONFIG.API_URL;
      
      if (!TUSHARE_API_KEY) {
        throw new Error('请配置TUSHARE_TOKEN环境变量');
      }

      const results: any[] = [];

      // 处理主营业务融合调用
      if (args.data_type === 'mainbz') {
        // 主营业务融合模式：直接在这里处理三个主营业务类型
        const businessTypes = ['P', 'D', 'I'];
        const businessNames = { 'P': '产品', 'D': '地区', 'I': '行业' };
        const combinedData: any[] = [];
        
        for (const businessType of businessTypes) {
          try {
            const result = await fetchFinancialData(
              'mainbz',
              args.ts_code,
              args.period,
              args.start_date,
              args.end_date,
              TUSHARE_API_KEY,
              TUSHARE_API_URL,
              businessType
            );
            
            if (result.data && result.data.length > 0) {
              // 为每条数据添加业务类型标识
              result.data.forEach((item: any) => {
                item.bz_type = businessNames[businessType as keyof typeof businessNames];
                item.bz_type_code = businessType;
              });
              combinedData.push(...result.data);
            }
          } catch (error) {
            // 获取主营业务构成数据失败，跳过该模块
          }
        }
        
        if (combinedData.length > 0) {
          results.push({
            type: 'mainbz',
            data: combinedData,
            fields: ['ts_code', 'end_date', 'bz_item', 'bz_sales', 'bz_profit', 'bz_cost', 'curr_type', 'bz_type', 'bz_type_code']
          });
        } else {
          results.push({
            type: 'mainbz',
            error: '未获取到任何主营业务构成数据'
          });
        }
        
        // 格式化输出
        const formattedOutput = formatFinancialData(results, args.ts_code);
        
        return {
          content: [{ type: "text", text: formattedOutput }]
        };
      }

      // 处理其他数据类型
      const dataTypes = [args.data_type];

      for (const dataType of dataTypes) {
        try {
          // 普通数据类型处理
          const result = await fetchFinancialData(
            dataType,
            args.ts_code,
            args.period,
            args.start_date,
            args.end_date,
            TUSHARE_API_KEY,
            TUSHARE_API_URL
          );
          
          if (result.data && result.data.length > 0) {
            results.push({
              type: dataType,
              data: result.data,
              fields: result.fields
            });
          }
        } catch (error) {
          results.push({
            type: dataType,
            error: error instanceof Error ? error.message : '未知错误'
          });
        }
      }

      if (results.length === 0) {
        throw new Error(`未找到股票${args.ts_code}的综合表现数据`);
      }

      // 格式化输出
      const formattedOutput = formatFinancialData(results, args.ts_code);
      
      return {
        content: [{ type: "text", text: formattedOutput }]
      };

    } catch (error) {
      return {
        content: [{ 
          type: "text", 
          text: `查询公司综合表现数据时发生错误: ${error instanceof Error ? error.message : '未知错误'}` 
        }]
      };
    }
  }
};

// 获取财务数据的通用函数
async function fetchFinancialData(
  dataType: string,
  tsCode: string,
  period: string | undefined,
  startDate: string,
  endDate: string,
  apiKey: string,
  apiUrl: string,
  businessType?: string
) {
  const apiConfigs: Record<string, any> = {
    forecast: {
      api_name: "forecast",
      default_fields: "ts_code,ann_date,end_date,type,p_change_min,p_change_max,net_profit_min,net_profit_max,last_parent_net,first_ann_date,summary,change_reason"
    },
    express: {
      api_name: "express",
      default_fields: "ts_code,ann_date,end_date,revenue,operate_profit,total_profit,n_income,total_assets,total_hldr_eqy_exc_min_int,diluted_eps,diluted_roe,yoy_net_profit,bps,yoy_sales,yoy_op,yoy_tp,yoy_dedu_np,yoy_eps,yoy_roe,growth_assets,yoy_equity,growth_bps,or_last_year,op_last_year,tp_last_year,np_last_year,eps_last_year,open_net_assets,open_bps,perf_summary,is_audit,remark"
    },
    indicators: {
      api_name: "fina_indicator",
      default_fields: "" // 空字符串表示获取所有字段
    },
    dividend: {
      api_name: "dividend",
      default_fields: "ts_code,end_date,ann_date,div_proc,stk_div,stk_bo_rate,stk_co_rate,cash_div,cash_div_tax,record_date,ex_date,pay_date,div_listdate,imp_ann_date,base_date,base_share"
    },
    mainbz: {
      api_name: "fina_mainbz",
      default_fields: "ts_code,end_date,bz_item,bz_sales,bz_profit,bz_cost,curr_type,update_flag",
      business_types: ["P", "D", "I"] // 融合三种类型：产品(P)、地区(D)、行业(I)
    },
    holder_number: {
      api_name: "stk_holdernumber",
      default_fields: "ts_code,ann_date,end_date,holder_num"
    },
    holder_trade: {
      api_name: "stk_holdertrade",
      default_fields: "ts_code,ann_date,holder_name,holder_type,in_de,change_vol,change_ratio,after_share,after_ratio,avg_price,total_share,begin_date,close_date"
    },
    managers: {
      api_name: "stk_managers",
      default_fields: "ts_code,ann_date,name,gender,lev,title,edu,national,birthday,begin_date,end_date,resume"
    },
    company_basic: {
      api_name: "stock_company",
      default_fields: "ts_code,com_name,com_id,exchange,chairman,manager,secretary,reg_capital,setup_date,province,city,introduction,website,email,office,employees,main_business,business_scope"
    },
    audit: {
      api_name: "fina_audit",
      default_fields: "ts_code,ann_date,end_date,audit_result,audit_fees,audit_agency,audit_sign"
    },
    balance_basic: {
      api_name: "balancesheet",
      default_fields: "ts_code,ann_date,f_ann_date,end_date,report_type,comp_type,total_assets,total_cur_assets,total_nca,total_liab,total_cur_liab,total_ncl,total_hldr_eqy_exc_min_int,total_hldr_eqy_inc_min_int,total_liab_hldr_eqy"
    },
    balance_all: {
      api_name: "balancesheet",
      default_fields: "" // 空字符串表示获取所有字段
    },
    cashflow_basic: {
      api_name: "cashflow",
      default_fields: "ts_code,ann_date,f_ann_date,end_date,comp_type,report_type,net_profit,finan_exp,c_fr_sale_sg,recp_tax_rends,n_depos_incr_fi,n_incr_loans_cb,n_inc_borr_oth_fi,prem_fr_orig_contr,n_incr_insured_dep,n_reinsur_prem,n_incr_disp_tfa,ifc_cash_incr,n_incr_disp_faas,n_incr_loans_oth_bank,n_cap_incr_repur,c_fr_oth_operate_a,c_inf_fr_operate_a,c_paid_goods_s,c_paid_to_for_empl,c_paid_for_taxes,n_incr_clt_loan_adv,n_incr_dep_cbob,c_pay_claims_orig_inco,pay_handling_chrg,pay_comm_insur_plcy,oth_cash_pay_oper_act,st_cash_out_act,n_cashflow_act,oth_recp_ral_inv_act,c_disp_withdrwl_invest,c_recp_return_invest,n_recp_disp_fiolta,n_recp_disp_sobu,stot_inflows_inv_act,c_pay_acq_const_fiolta,c_paid_invest,n_disp_subs_oth_biz,oth_pay_ral_inv_act,n_incr_pledge_loan,stot_out_inv_act,n_cashflow_inv_act,c_recp_borrow,proc_issue_bonds,oth_cash_recp_ral_fnc_act,stot_cash_in_fnc_act,free_cashflow,c_prepay_amt_borr,c_pay_dist_dpcp_int_exp,incl_dvd_profit_paid_sc_ms,oth_cashpay_ral_fnc_act,stot_cashout_fnc_act,n_cash_flows_fnc_act,eff_fx_flu_cash,n_incr_cash_cash_equ,c_cash_equ_beg_period,c_cash_equ_end_period,c_recp_cap_contrib,incl_cash_rec_saims,uncon_invest_loss,prov_depr_assets,depr_fa_coga_dpba,amort_intang_assets,lt_amort_deferred_exp,decr_deferred_exp,incr_acc_exp,loss_disp_fiolta,loss_scr_fa,loss_fv_chg,invest_loss,decr_def_inc_tax_assets,incr_def_inc_tax_liab,decr_inventories,decr_oper_payable,incr_oper_payable,others,im_net_cashflow_oper_act,conv_debt_into_cap,conv_copbonds_due_within_1y,fa_fnc_leases,end_bal_cash,beg_bal_cash,end_bal_cash_equ,beg_bal_cash_equ,im_n_incr_cash_equ"
    },
    cashflow_all: {
      api_name: "cashflow",
      default_fields: "" // 空字符串表示获取所有字段
    },
    income_basic: {
      api_name: "income",
      default_fields: "ts_code,ann_date,f_ann_date,end_date,report_type,comp_type,basic_eps,diluted_eps,total_revenue,revenue,total_cogs,oper_cost,operate_profit,total_profit,income_tax,n_income,n_income_attr_p,ebit,ebitda"
    },
    income_all: {
      api_name: "income",
      default_fields: "" // 空字符串表示获取所有字段
    },
    share_float: {
      api_name: "share_float",
      default_fields: "ts_code,ann_date,float_date,float_share,float_ratio,holder_name,share_type"
    },
    repurchase: {
      api_name: "repurchase",
      default_fields: "ts_code,ann_date,end_date,proc,exp_date,vol,amount,high_limit,low_limit"
    },
    top10_holders: {
      api_name: "top10_holders",
      default_fields: "ts_code,ann_date,end_date,holder_name,hold_amount,hold_ratio,hold_change,holder_type"
    },
    top10_floatholders: {
      api_name: "top10_floatholders",
      default_fields: "ts_code,ann_date,end_date,holder_name,hold_amount,hold_ratio,hold_float_ratio,hold_change,holder_type"
    },
    pledge_stat: {
      api_name: "pledge_stat",
      default_fields: "ts_code,end_date,pledge_count,unrest_pledge,rest_pledge,total_share,pledge_ratio"
    },
    pledge_detail: {
      api_name: "pledge_detail",
      default_fields: "ts_code,ann_date,holder_name,pledge_amount,start_date,end_date,is_release,release_date,pledgor,holding_amount,pledged_amount,p_total_ratio,h_total_ratio,is_buyback"
    }
  };

  const config = apiConfigs[dataType];
  if (!config) {
    throw new Error(`不支持的数据类型: ${dataType}`);
  }

  // 构建请求参数
  const params: any = {
    api_name: config.api_name,
    token: apiKey,
    params: {
      ts_code: tsCode
    }
  };

  // 添加字段参数（如果不是balance_all类型）
  if (config.default_fields) {
    params.fields = config.default_fields;
  }

  // 根据不同的API添加特定参数
  if (['indicators'].includes(dataType)) {
    if (period) {
      params.params.period = period;
    } else {
      params.params.start_date = startDate;
      params.params.end_date = endDate;
    }
  } else if (['forecast', 'express'].includes(dataType)) {
    params.params.start_date = startDate;
    params.params.end_date = endDate;
  } else if (dataType === 'dividend') {
    // 分红数据不在API级别过滤，在返回后过滤
  } else   if (dataType === 'mainbz') {
    // 主营业务构成融合数据
    if (period) {
      params.params.period = period;
    } else {
      params.params.start_date = startDate;
      params.params.end_date = endDate;
    }
    // 设置业务类型参数（从调用时传入）
    params.params.type = businessType;
  } else if (['holder_number', 'holder_trade', 'managers', 'audit'].includes(dataType)) {
    // 股东人数、股东增减持、管理层信息和审计意见数据
    params.params.start_date = startDate;
    params.params.end_date = endDate;
  } else if (dataType === 'company_basic') {
    // 上市公司基本信息，支持通过exchange参数查询特定交易所
    // 不需要日期参数，是基础信息查询
  } else if (['balance_basic', 'balance_all'].includes(dataType)) {
    // 资产负债表数据
    if (period) {
      params.params.period = period;
    } else {
      params.params.start_date = startDate;
      params.params.end_date = endDate;
    }
  } else if (['cashflow_basic', 'cashflow_all'].includes(dataType)) {
    // 现金流量表数据
    if (period) {
      params.params.period = period;
    } else {
      params.params.start_date = startDate;
      params.params.end_date = endDate;
    }
  } else if (['income_basic', 'income_all'].includes(dataType)) {
    // 利润表数据
    if (period) {
      params.params.period = period;
    } else {
      params.params.start_date = startDate;
      params.params.end_date = endDate;
    }
  } else if (dataType === 'share_float') {
    // 限售股解禁数据
    params.params.start_date = startDate;
    params.params.end_date = endDate;
  } else if (dataType === 'repurchase') {
    // 股票回购数据
    params.params.start_date = startDate;
    params.params.end_date = endDate;
  } else if (['top10_holders', 'top10_floatholders'].includes(dataType)) {
    // 前十大股东和前十大流通股东数据
    if (period) {
      params.params.period = period;
    } else {
      params.params.start_date = startDate;
      params.params.end_date = endDate;
    }
  } else if (dataType === 'pledge_stat') {
    // 股权质押统计数据 - 使用end_date参数
    params.params.end_date = endDate;
  } else if (dataType === 'pledge_detail') {
    // 股权质押明细数据 - 只需要ts_code，不需要日期参数
  }


  // 设置请求超时
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TUSHARE_CONFIG.TIMEOUT);

  try {
    const response = await fetch(apiUrl!, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(params),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Tushare API请求失败: ${response.status}`);
    }

    const data = await response.json();

    if (data.code !== 0) {
      throw new Error(`Tushare API错误: ${data.msg}`);
    }

    if (!data.data || !data.data.items || data.data.items.length === 0) {
      return { data: [], fields: [] };
    }

    // 获取字段名
    const fieldsArray = data.data.fields;

    // 将数据转换为对象数组
    let resultData = data.data.items.map((item: any) => {
      const result: Record<string, any> = {};
      fieldsArray.forEach((field: string, index: number) => {
        result[field] = item[index];
      });
      return result;
    });

    // 对dividend数据进行日期范围过滤
    if (dataType === 'dividend') {
      resultData = resultData.filter((item: any) => {
        // 使用ann_date（公告日期）进行过滤
        const annDate = item.ann_date;
        if (!annDate) return true; // 如果没有公告日期，保留数据
        
        // 转换日期格式进行比较 (YYYYMMDD格式)
        return annDate >= startDate && annDate <= endDate;
      });
    }

    // 对pledge_stat数据进行日期范围过滤
    if (dataType === 'pledge_stat') {
      resultData = resultData.filter((item: any) => {
        // 使用end_date（截止日期）进行过滤
        const endDateItem = item.end_date;
        if (!endDateItem) return true; // 如果没有截止日期，保留数据
        
        // 转换日期格式进行比较 (YYYYMMDD格式)
        return endDateItem >= startDate && endDateItem <= endDate;
      });
    }

    return { data: resultData, fields: fieldsArray };

  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

// 格式化财务数据输出
function formatFinancialData(results: any[], tsCode: string): string {
  let output = `# 📊 ${tsCode} 公司财务表现分析\n\n`;

  const dataTypeNames: Record<string, string> = {
    forecast: '🔮 业绩预告',
    express: '⚡ 业绩快报',
    indicators: '📊 财务指标',
    dividend: '💵 分红送股',
    mainbz: '🏭 主营业务构成(融合版)',
    holder_number: '👥 股东人数',
    holder_trade: '📊 股东增减持',
    managers: '👔 管理层信息',
    audit: '🔍 财务审计意见',
    company_basic: '🏢 上市公司基本信息',
    balance_basic: '⚖️ 核心资产负债表',
    balance_all: '⚖️ 完整资产负债表',
    cashflow_basic: '💰 基础现金流量表',
    cashflow_all: '💰 完整现金流量表',
    income_basic: '💹 核心利润表',
    income_all: '💹 完整利润表',
    share_float: '🔓 限售股解禁',
    repurchase: '🔄 股票回购',
    top10_holders: '👥 前十大股东',
    top10_floatholders: '🌊 前十大流通股东',
    pledge_stat: '📊 股权质押统计',
    pledge_detail: '📋 股权质押明细'
  };

  for (const result of results) {
    const typeName = dataTypeNames[result.type] || result.type;
    output += `## ${typeName}\n\n`;

    if (result.error) {
      output += `❌ 获取失败: ${result.error}\n\n`;
      continue;
    }

    if (!result.data || result.data.length === 0) {
      output += `ℹ️ 暂无数据\n\n`;
      continue;
    }

    // 根据不同数据类型格式化输出
    switch (result.type) {
      case 'forecast':
        output += formatForecast(result.data);
        break;
      case 'express':
        output += formatExpress(result.data);
        break;
      case 'indicators':
        output += formatIndicators(result.data);
        break;
      case 'dividend':
        output += formatDividend(result.data);
        break;
      case 'mainbz':
        output += formatMainBusinessCombined(result.data);
        break;
      case 'holder_number':
        output += formatHolderNumber(result.data);
        break;
      case 'holder_trade':
        output += formatHolderTrade(result.data);
        break;
      case 'managers':
        output += formatManagement(result.data);
        break;
      case 'audit':
        output += formatAudit(result.data);
        break;
      case 'company_basic':
        output += formatCompanyBasic(result.data);
        break;
      case 'balance_basic':
        output += formatBasicBalance(result.data);
        break;
      case 'balance_all':
        output += formatAllBalance(result.data);
        break;
      case 'cashflow_basic':
        output += formatBasicCashFlow(result.data);
        break;
      case 'cashflow_all':
        output += formatCashflowAll(result.data);
        break;
      case 'income_basic':
        output += formatBasicIncome(result.data);
        break;
      case 'income_all':
        output += formatAllIncome(result.data);
        break;
      case 'share_float':
        output += formatShareFloat(result.data);
        break;
      case 'repurchase':
        output += formatRepurchase(result.data);
        break;
      case 'top10_holders':
        output += formatTop10Holders(result.data);
        break;
      case 'top10_floatholders':
        output += formatTop10FloatHolders(result.data);
        break;
      case 'pledge_stat':
        output += formatPledgeStat(result.data);
        break;
      case 'pledge_detail':
        output += formatPledgeDetail(result.data);
        break;
      default:
        output += formatGenericData(result.data, result.fields);
    }

    output += '\n---\n\n';
  }

  return output;
}










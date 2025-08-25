import { TUSHARE_CONFIG } from '../config.js';

// 基金经理按姓名查询工具
export const fundManagerByName = {
  name: "fund_manager_by_name",
  description: "根据基金经理姓名查询基金经理详细信息，包括管理的基金列表、个人背景、任职经历等",
  inputSchema: {
    type: "object" as const,
    properties: {
      name: {
        type: "string",
        description: "基金经理姓名，如'张凯'、'刘彦春'等"
      },
      ann_date: {
        type: "string",
        description: "公告日期，格式为YYYYMMDD，如'20230101'。用于限制查询的公告日期"
      }
    },
    required: ["name"]
  }
};

// 类型定义
interface FundRecord {
  tsCode: string;
  annDate: string;
  beginDate: string;
  endDate: string;
}

interface ManagerInfo {
  managerName: string;
  gender: string;
  birthYear: string;
  edu: string;
  nationality: string;
  resume: string;
}

interface PersonData {
  info: ManagerInfo;
  funds: FundRecord[];
}

interface RawRecord {
  tsCode: string;
  annDate: string;
  managerName: string;
  gender: string;
  birthYear: string;
  edu: string;
  nationality: string;
  beginDate: string;
  endDate: string;
  resume: string;
}

// 获取基金经理数据
async function fetchFundManagerData(
  name: string,
  annDate?: string,
  apiKey?: string,
  apiUrl?: string
) {
  if (!apiKey || !apiUrl) {
    throw new Error("API配置未找到");
  }

  const params: any = {
    api_name: "fund_manager",
    token: apiKey,
    params: {
      name: name
    },
    fields: "ts_code,ann_date,name,gender,birth_year,edu,nationality,begin_date,end_date,resume"
  };

  if (annDate) {
    params.params.ann_date = annDate;
  }

  const response = await fetch(apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params)
  });

  if (!response.ok) {
    throw new Error(`API请求失败: ${response.statusText}`);
  }

  const result = await response.json();
  
  if (result.code !== 0) {
    throw new Error(`API返回错误: ${result.msg}`);
  }

  return result.data;
}

// 格式化日期显示
function formatDate(dateStr: string): string {
  if (!dateStr || dateStr === 'N/A') return 'N/A';
  if (dateStr.length === 8) {
    return `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;
  }
  return dateStr;
}

// 计算两个简历的相似度
function calculateResumeSimilarity(resume1: string, resume2: string): number {
  if (!resume1 || !resume2) return 0;
  
  // 提取关键信息进行比较
  const extractKeywords = (resume: string) => {
    const keywords = new Set<string>();
    
    // 提取学校名称
    const schoolMatches = resume.match(/[大学|学院|University|College]+/g);
    if (schoolMatches) {
      schoolMatches.forEach(school => keywords.add(school.toLowerCase()));
    }
    
    // 提取公司名称
    const companyMatches = resume.match(/[基金|投资|证券|银行|保险|资管]+/g);
    if (companyMatches) {
      companyMatches.forEach(company => keywords.add(company.toLowerCase()));
    }
    
    // 提取学位信息
    const degreeMatches = resume.match(/[硕士|博士|学士|MBA|CFA|FRM]+/g);
    if (degreeMatches) {
      degreeMatches.forEach(degree => keywords.add(degree.toLowerCase()));
    }
    
    return keywords;
  };
  
  const keywords1 = extractKeywords(resume1);
  const keywords2 = extractKeywords(resume2);
  
  if (keywords1.size === 0 && keywords2.size === 0) return 0;
  
  // 计算交集
  const intersection = new Set([...keywords1].filter(x => keywords2.has(x)));
  const union = new Set([...keywords1, ...keywords2]);
  
  return intersection.size / union.size;
}

// 判断两个记录是否是同一人
function isSamePerson(record1: RawRecord, record2: RawRecord): boolean {
  // 姓名和性别必须相同
  if (record1.managerName !== record2.managerName || record1.gender !== record2.gender) {
    return false;
  }
  
  // 如果出生年份都有且不同，则认为是不同人
  if (record1.birthYear && record2.birthYear && 
      record1.birthYear !== 'N/A' && record2.birthYear !== 'N/A' && 
      record1.birthYear !== record2.birthYear) {
    return false;
  }
  
  // 如果学历完全相同（且不为空），认为可能是同一人
  if (record1.edu && record2.edu && record1.edu !== 'N/A' && record2.edu !== 'N/A') {
    if (record1.edu === record2.edu) {
      return true;
    }
  }
  
  // 如果简历相似度高，认为是同一人
  const similarity = calculateResumeSimilarity(record1.resume, record2.resume);
  if (similarity > 0.3) { // 30%以上相似度认为是同一人
    return true;
  }
  
  // 如果都没有出生年份，学历也不同或为空，但国籍相同，暂时认为是同一人
  if ((!record1.birthYear || record1.birthYear === 'N/A') && 
      (!record2.birthYear || record2.birthYear === 'N/A') &&
      record1.nationality === record2.nationality) {
    return true;
  }
  
  return false;
}

// 智能分组：将同一人的记录合并
function groupRecordsByPerson(records: RawRecord[]): PersonData[] {
  const groups: PersonData[] = [];
  
  for (const record of records) {
    let foundGroup = false;
    
    // 尝试找到匹配的现有组
    for (const group of groups) {
      const representativeRecord: RawRecord = {
        tsCode: '', // 不重要
        annDate: '',
        managerName: group.info.managerName,
        gender: group.info.gender,
        birthYear: group.info.birthYear,
        edu: group.info.edu,
        nationality: group.info.nationality,
        beginDate: '',
        endDate: '',
        resume: group.info.resume
      };
      
      if (isSamePerson(record, representativeRecord)) {
        // 添加到现有组
        group.funds.push({
          tsCode: record.tsCode,
          annDate: record.annDate,
          beginDate: record.beginDate,
          endDate: record.endDate
        });
        
        // 更新组信息（优先使用更完整的信息）
        if (!group.info.birthYear || group.info.birthYear === 'N/A') {
          if (record.birthYear && record.birthYear !== 'N/A') {
            group.info.birthYear = record.birthYear;
          }
        }
        if (!group.info.edu || group.info.edu === 'N/A') {
          if (record.edu && record.edu !== 'N/A') {
            group.info.edu = record.edu;
          }
        }
        if (!group.info.resume || group.info.resume.length < record.resume.length) {
          if (record.resume) {
            group.info.resume = record.resume;
          }
        }
        
        foundGroup = true;
        break;
      }
    }
    
    // 如果没有找到匹配的组，创建新组
    if (!foundGroup) {
      groups.push({
        info: {
          managerName: record.managerName,
          gender: record.gender,
          birthYear: record.birthYear,
          edu: record.edu,
          nationality: record.nationality,
          resume: record.resume
        },
        funds: [{
          tsCode: record.tsCode,
          annDate: record.annDate,
          beginDate: record.beginDate,
          endDate: record.endDate
        }]
      });
    }
  }
  
  return groups;
}

// 格式化基金经理数据输出
function formatFundManagerData(data: any, name: string): string {
  let output = `# 基金经理查询结果\n\n`;
  output += `查询基金经理: ${name}\n\n`;

  if (!data || !data.items || data.items.length === 0) {
    return output + "没有找到相关的基金经理信息。\n";
  }

  const items = data.items;
  
  // 转换为统一的记录格式
  const records: RawRecord[] = items.map((item: any) => {
    const [tsCode, annDate, managerName, gender, birthYear, edu, nationality, beginDate, endDate, resume] = item;
    return {
      tsCode, annDate, managerName, gender, birthYear, edu, nationality, beginDate, endDate, resume
    };
  });
  
  // 智能分组
  const personGroups = groupRecordsByPerson(records);

  let personIndex = 1;
  for (const personData of personGroups) {
    const { info, funds } = personData;
    const { managerName, gender, birthYear, edu, nationality, resume } = info;
    
    // 如果有多个人
    if (personGroups.length > 1) {
      output += `## ${personIndex}. 基金经理信息\n\n`;
    }

    // 个人基本信息（只显示一次）
    output += `### 个人基本信息\n\n`;
    output += `| 项目 | 信息 |\n`;
    output += `|------|------|\n`;
    output += `| 姓名 | ${managerName || 'N/A'} |\n`;
    output += `| 性别 | ${gender === 'M' ? '男' : gender === 'F' ? '女' : gender || 'N/A'} |\n`;
    output += `| 出生年份 | ${birthYear || 'N/A'} |\n`;
    output += `| 学历 | ${edu || 'N/A'} |\n`;
    output += `| 国籍 | ${nationality || 'N/A'} |\n`;
    
    if (resume) {
      output += `\n个人简历:\n${resume}\n`;
    }
    
    // 基金管理信息统计
    const activeFunds = funds.filter((fund: FundRecord) => !fund.endDate || fund.endDate === '在任');
    const historicalFunds = funds.filter((fund: FundRecord) => fund.endDate && fund.endDate !== '在任');
    
    output += `\n### 基金管理概况\n\n`;
    output += `- 管理基金总数: ${funds.length} 只\n`;
    output += `- 当前在任: ${activeFunds.length} 只\n`;
    output += `- 历史管理: ${historicalFunds.length} 只\n\n`;
    
    // 当前在任基金
    if (activeFunds.length > 0) {
      output += `### 当前在任基金 (${activeFunds.length}只)\n\n`;
      output += `| 基金代码 | 任职开始日期 | 最新公告日期 |\n`;
      output += `|----------|--------------|---------------|\n`;
      
      // 按任职开始日期排序
      activeFunds.sort((a: FundRecord, b: FundRecord) => (b.beginDate || '').localeCompare(a.beginDate || ''));
      
      activeFunds.forEach((fund: FundRecord) => {
        output += `| ${fund.tsCode} | ${formatDate(fund.beginDate)} | ${formatDate(fund.annDate)} |\n`;
      });
      output += `\n`;
    }
    
    // 历史管理基金
    if (historicalFunds.length > 0) {
      output += `### 历史管理基金 (${historicalFunds.length}只)\n\n`;
      output += `| 基金代码 | 任职开始日期 | 任职结束日期 | 公告日期 |\n`;
      output += `|----------|--------------|--------------|----------|\n`;
      
      // 按结束日期倒序排序
      historicalFunds.sort((a: FundRecord, b: FundRecord) => (b.endDate || '').localeCompare(a.endDate || ''));
      
      historicalFunds.forEach((fund: FundRecord) => {
        output += `| ${fund.tsCode} | ${formatDate(fund.beginDate)} | ${formatDate(fund.endDate)} | ${formatDate(fund.annDate)} |\n`;
      });
      output += `\n`;
    }
    
    if (personGroups.length > 1) {
      output += `---\n\n`;
    }
    personIndex++;
  }

  return output;
}

// 工具实现函数
export async function runFundManagerByName(args: { 
  name: string; 
  ann_date?: string; 
}) {
  try {
    const TUSHARE_API_KEY = TUSHARE_CONFIG.API_TOKEN;
    const TUSHARE_API_URL = TUSHARE_CONFIG.API_URL;

    if (!TUSHARE_API_KEY) {
      return {
        content: [{ type: "text", text: "错误: 未设置TUSHARE_TOKEN环境变量" }]
      };
    }

    const data = await fetchFundManagerData(
      args.name,
      args.ann_date,
      TUSHARE_API_KEY,
      TUSHARE_API_URL
    );

    const formattedOutput = formatFundManagerData(data, args.name);
    
    return {
      content: [{ type: "text", text: formattedOutput }]
    };

  } catch (error) {
    return {
      content: [{ type: "text", text: `查询基金经理信息时发生错误: ${error instanceof Error ? error.message : String(error)}` }]
    };
  }
} 
/**
 * 上市公司管理层数据格式化模块
 * 处理管理层人员信息的格式化和统计分析
 */

interface ManagerData {
  ts_code: string;
  ann_date: string;
  name: string;
  gender: string;
  lev: string;
  title: string;
  edu: string;
  national: string;
  birthday: string;
  begin_date: string;
  end_date: string;
  resume?: string;
}

/**
 * 格式化管理层数据
 */
export function formatManagement(data: ManagerData[]): string {
  if (!data || data.length === 0) {
    return "未找到管理层数据。";
  }


  let result = `## 📋 上市公司管理层信息\n\n`;

  // 基础表格展示
  result += `### 管理层人员列表\n\n`;
  result += `| 公告日期 | 姓名 | 性别 | 岗位类别 | 职务 | 学历 | 国籍 | 出生年月 | 上任日期 | 离任日期 |\n`;
  result += `|---------|------|------|----------|------|------|------|----------|----------|----------|\n`;

  data.forEach((record: ManagerData) => {
    result += `| ${record.ann_date || 'N/A'} | ${record.name || 'N/A'} | ${record.gender === 'M' ? '男' : record.gender === 'F' ? '女' : 'N/A'} | ${record.lev || 'N/A'} | ${record.title || 'N/A'} | ${record.edu || 'N/A'} | ${record.national || 'N/A'} | ${record.birthday || 'N/A'} | ${record.begin_date || 'N/A'} | ${record.end_date || '在任'} |\n`;
  });

  // 统计分析
  result += `\n### 📊 管理层统计分析\n\n`;

  // 1. 性别分布统计
  const genderStats: Record<string, number> = {};
  data.forEach(record => {
    const gender = record.gender === 'M' ? '男' : record.gender === 'F' ? '女' : '未知';
    genderStats[gender] = (genderStats[gender] || 0) + 1;
  });

  result += `**👥 性别分布：**\n`;
  Object.entries(genderStats).forEach(([gender, count]) => {
    const percentage = ((count / data.length) * 100).toFixed(1);
    result += `- ${gender}: ${count}人 (${percentage}%)\n`;
  });

  // 2. 岗位类别分布统计
  const levelStats: Record<string, number> = {};
  data.forEach(record => {
    const level = record.lev || '未知';
    levelStats[level] = (levelStats[level] || 0) + 1;
  });

  result += `\n**🏢 岗位类别分布：**\n`;
  Object.entries(levelStats)
    .sort(([, a], [, b]) => b - a)
    .forEach(([level, count]) => {
      const percentage = ((count / data.length) * 100).toFixed(1);
      result += `- ${level}: ${count}人 (${percentage}%)\n`;
    });

  // 3. 学历分布统计
  const eduStats: Record<string, number> = {};
  data.forEach(record => {
    const edu = record.edu || '未知';
    eduStats[edu] = (eduStats[edu] || 0) + 1;
  });

  result += `\n**🎓 学历分布：**\n`;
  Object.entries(eduStats)
    .sort(([, a], [, b]) => b - a)
    .forEach(([edu, count]) => {
      const percentage = ((count / data.length) * 100).toFixed(1);
      result += `- ${edu}: ${count}人 (${percentage}%)\n`;
    });

  // 4. 国籍分布统计
  const nationalStats: Record<string, number> = {};
  data.forEach(record => {
    const national = record.national || '未知';
    nationalStats[national] = (nationalStats[national] || 0) + 1;
  });

  result += `\n**🌍 国籍分布：**\n`;
  Object.entries(nationalStats)
    .sort(([, a], [, b]) => b - a)
    .forEach(([national, count]) => {
      const percentage = ((count / data.length) * 100).toFixed(1);
      result += `- ${national}: ${count}人 (${percentage}%)\n`;
    });

  // 5. 年龄分析（基于出生年月）
  const currentYear = new Date().getFullYear();
  const ages: number[] = [];
  data.forEach(record => {
    if (record.birthday) {
      // 处理不同的出生年月格式
      let birthYear: number;
      if (record.birthday.length === 4) {
        // 只有年份
        birthYear = parseInt(record.birthday);
      } else if (record.birthday.length === 6) {
        // YYYYMM格式
        birthYear = parseInt(record.birthday.substring(0, 4));
      } else if (record.birthday.length === 8) {
        // YYYYMMDD格式
        birthYear = parseInt(record.birthday.substring(0, 4));
      } else {
        return; // 跳过无效格式
      }
      
      if (birthYear && birthYear > 1900 && birthYear < currentYear) {
        ages.push(currentYear - birthYear);
      }
    }
  });

  if (ages.length > 0) {
    const avgAge = (ages.reduce((sum, age) => sum + age, 0) / ages.length).toFixed(1);
    const minAge = Math.min(...ages);
    const maxAge = Math.max(...ages);
    
    result += `\n**🎂 年龄分析：**\n`;
    result += `- 平均年龄: ${avgAge}岁\n`;
    result += `- 年龄范围: ${minAge}-${maxAge}岁\n`;
    result += `- 统计样本: ${ages.length}人\n`;
  }

  // 6. 任职状态统计
  const statusStats = {
    active: 0,    // 在任
    resigned: 0   // 离任
  };
  
  data.forEach(record => {
    if (record.end_date && record.end_date !== 'None' && record.end_date.trim() !== '') {
      statusStats.resigned++;
    } else {
      statusStats.active++;
    }
  });

  result += `\n**💼 任职状态：**\n`;
  result += `- 在任: ${statusStats.active}人 (${((statusStats.active / data.length) * 100).toFixed(1)}%)\n`;
  result += `- 离任: ${statusStats.resigned}人 (${((statusStats.resigned / data.length) * 100).toFixed(1)}%)\n`;

  // 数据汇总信息
  result += `\n---\n`;
  result += `📅 **数据统计时间:** ${new Date().toLocaleString('zh-CN')}\n`;
  result += `📊 **管理层记录总数:** ${data.length}条\n`;
  result += `🏢 **数据来源:** Tushare上市公司管理层接口\n`;

  return result;
}
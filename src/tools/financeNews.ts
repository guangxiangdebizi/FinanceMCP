import { removeDuplicates } from './crawler/utils.js';
import { searchBaiduNews } from './crawler/baiduNews.js';

export interface NewsItem {
  title: string;
  summary: string;
  url: string;
  source: string;
  publishTime: string;
  keywords: string[];
}

export const financeNews = {
  name: "finance_news",
  description: "通过真正的搜索API获取主流财经媒体的新闻内容，支持单个或多个关键词智能搜索。示例：'药明康德'、'美联储 加息'、'比特币 监管'",
  inputSchema: {
    type: "object" as const,
    properties: {
      query: {
        type: "string" as const,
        description: "搜索关键词，支持单个关键词如'药明康德'、'腾讯'，或多个关键词用空格分开如'美联储 加息'、'比特币 监管'等。系统会智能搜索相关历史新闻",
        minLength: 1,
        maxLength: 100
      }
    },
    required: ["query"]
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
      }
    },
    required: ["content"]
  } as const,
  async run(args: { 
    query: string;
  }) {
    try {
      if (!args.query || args.query.trim().length === 0) {
        throw new Error("搜索关键词不能为空");
      }
      
      const query = args.query.trim();
      
      
      const newsResults = await searchFinanceNews(query);
    
      if (newsResults.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `# ${query} 财经新闻搜索结果\n\n未找到相关财经新闻`
            }
          ]
        };
      }
    
      
      // 简化返回格式，参考stock_data的格式
      const formattedNews = newsResults.map((news) => {
        return `${news.title}\n来源: ${news.source}  时间: ${news.publishTime}\n摘要: ${news.summary}${news.url ? `\n链接: ${news.url}` : ''}\n`;
      }).join('\n---\n\n');
      
      return {
        content: [
          {
            type: "text",
            text: `# ${query} 财经新闻搜索结果\n\n${formattedNews}`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `# ${args.query || '财经新闻'} 搜索失败\n\n错误信息: ${error instanceof Error ? error.message : '未知错误'}`
          }
        ]
      };
    }
  }
};

async function searchFinanceNews(query: string): Promise<NewsItem[]> {
  const news: NewsItem[] = [];
  const keywords = query.split(' ').filter(k => k.trim().length > 0);
  
  // 并发搜索多个有效的媒体源（当前仅百度）
  const searchPromises = [
    searchBaiduNews(keywords)
  ];

  try {
    const results = await Promise.allSettled(searchPromises);
    
    results.forEach((result, index) => {
      const sourceNames = ['百度新闻'];
      if (result.status === 'fulfilled') {
        news.push(...result.value);
      } else {
      }
    });

    // 去重
    const uniqueNews = removeDuplicates(news);
    return uniqueNews.slice(0, 20); // 最多返回20条
    
  } catch (error) {
    return [];
  }
}

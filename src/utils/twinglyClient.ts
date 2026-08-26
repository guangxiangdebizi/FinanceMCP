import { TWINGLY_CONFIG } from '../config.js';

export type TwinglyClientErrorKind =
  | 'not_configured'
  | 'auth'
  | 'rate_limit'
  | 'timeout'
  | 'unavailable'
  | 'invalid_response'
  | 'request'
  | 'empty';

export class TwinglyClientError extends Error {
  constructor(
    public readonly kind: TwinglyClientErrorKind,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'TwinglyClientError';
  }
}

type TwinglyDocument = {
  article_id?: string | number;
  url?: string;
  title?: string;
  published_at?: string | null;
  timestamp?: string;
  location_code?: string | null;
  language_code?: string;
  site_id?: string | number;
  site_name?: string;
  site_url?: string;
  section_name?: string;
  section_url?: string;
  identical_documents?: TwinglyDocument[];
};

type TwinglySearchResponse = {
  number_of_documents?: number;
  number_of_documents_estimated_total?: number;
  documents?: TwinglyDocument[];
};

export type TwinglyNewsItem = {
  articleId: string;
  siteId: string;
  title: string;
  url: string;
  source: string;
  siteUrl: string;
  sectionName: string;
  sectionUrl: string;
  publishTime: string;
  languageCode: string;
  locationCode: string;
  duplicateCount: number;
};

type TwinglySearchResult = {
  items: TwinglyNewsItem[];
  estimatedTotal: number;
};

type ToolContent = { type: 'text'; text: string };
type ToolResult = { content: ToolContent[] };

const HOT_NEWS_TERMS = [
  'financial market', 'stock market', 'central bank', 'interest rate', 'bond market',
  'currency market', 'cryptocurrency', 'earnings', 'merger', 'acquisition',
  '财经', '金融市场', '股票', '债券', '汇率', '加密货币', '央行', '利率',
];

function isoSeconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function stripMarkup(value: unknown): string {
  return String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function preserveLargeIds(raw: string): string {
  return raw.replace(
    /("(?:site_id|article_id)"\s*:\s*)(\d{16,})/g,
    '$1"$2"',
  );
}

function responseErrorKind(status: number): TwinglyClientErrorKind {
  if (status === 400) return 'request';
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'unavailable';
  return 'request';
}

function normalizeDocument(document: TwinglyDocument): TwinglyNewsItem | undefined {
  const title = stripMarkup(document.title);
  const url = String(document.url ?? '').trim();
  if (!title || !url) return undefined;
  try {
    if (new URL(url).protocol !== 'https:') return undefined;
  } catch {
    return undefined;
  }

  return {
    articleId: String(document.article_id ?? ''),
    siteId: String(document.site_id ?? ''),
    title,
    url,
    source: stripMarkup(document.site_name) || 'Twingly',
    siteUrl: String(document.site_url ?? '').trim(),
    sectionName: stripMarkup(document.section_name),
    sectionUrl: String(document.section_url ?? '').trim(),
    publishTime: String(document.published_at ?? document.timestamp ?? '').trim(),
    languageCode: String(document.language_code ?? '').trim().toLowerCase(),
    locationCode: String(document.location_code ?? '').trim().toLowerCase(),
    duplicateCount: Array.isArray(document.identical_documents)
      ? document.identical_documents.length
      : 0,
  };
}

async function postSearch(query: Record<string, unknown>): Promise<TwinglySearchResult> {
  const apiKey = TWINGLY_CONFIG.API_KEY;
  if (!apiKey) {
    throw new TwinglyClientError('not_configured', '未配置 Twingly API key');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TWINGLY_CONFIG.TIMEOUT);
  try {
    let response: Response;
    try {
      response = await fetch(TWINGLY_CONFIG.SEARCH_URL, {
        method: 'POST',
        headers: {
          Authorization: `apikey ${apiKey}`,
          'Content-Type': 'application/json; charset=utf-8',
          Accept: 'application/json; charset=utf-8',
        },
        body: JSON.stringify(query),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new TwinglyClientError('timeout', 'Twingly News Search 请求超时');
      }
      throw new TwinglyClientError('unavailable', 'Twingly News Search 网络请求失败');
    }

    const raw = await response.text();
    if (Buffer.byteLength(raw, 'utf8') > TWINGLY_CONFIG.MAX_RESPONSE_BYTES) {
      throw new TwinglyClientError('invalid_response', 'Twingly 响应超过安全大小限制');
    }
    if (!response.ok) {
      throw new TwinglyClientError(
        responseErrorKind(response.status),
        `Twingly News Search 返回 HTTP ${response.status}`,
        response.status,
      );
    }

    let parsed: TwinglySearchResponse;
    try {
      parsed = JSON.parse(preserveLargeIds(raw)) as TwinglySearchResponse;
    } catch {
      throw new TwinglyClientError('invalid_response', 'Twingly 返回了无效 JSON');
    }
    if (!Array.isArray(parsed.documents)) {
      throw new TwinglyClientError('invalid_response', 'Twingly 响应缺少 documents 数组');
    }

    const items = parsed.documents
      .map(normalizeDocument)
      .filter((item): item is TwinglyNewsItem => Boolean(item));
    return {
      items,
      estimatedTotal: Number(parsed.number_of_documents_estimated_total ?? items.length),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function queryTerms(query: string): string[] {
  const normalized = query.trim().slice(0, 500);
  const terms = normalized.split(/\s+/).filter(Boolean).slice(0, 20);
  return terms.length ? terms : [normalized];
}

export async function searchTwinglyFinanceNews(query: string, size = 20): Promise<TwinglySearchResult> {
  const now = new Date();
  return postSearch({
    all: queryTerms(query),
    size: Math.min(50, Math.max(1, Math.floor(size))),
    sort: 'timestamp',
    order: 'desc',
    timestamp: {
      since: isoSeconds(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)),
      until: isoSeconds(now),
    },
    group_identical_documents: true,
  });
}

export async function searchTwinglyHotNews(size = 100): Promise<TwinglySearchResult> {
  const now = new Date();
  return postSearch({
    any: HOT_NEWS_TERMS,
    size: Math.min(50, Math.max(1, Math.floor(size))),
    sort: 'timestamp',
    order: 'desc',
    timestamp: {
      since: isoSeconds(new Date(now.getTime() - 24 * 60 * 60 * 1000)),
      until: isoSeconds(now),
    },
    group_identical_documents: true,
  });
}

function metadataLine(item: TwinglyNewsItem): string {
  const metadata = [
    item.languageCode ? `语言: ${item.languageCode}` : '',
    item.locationCode ? `地区: ${item.locationCode}` : '',
    item.siteId ? `site_id: ${item.siteId}` : '',
    item.duplicateCount ? `同源重复报道: ${item.duplicateCount}` : '',
  ].filter(Boolean).join('  ');
  return metadata ? `\n${metadata}` : '';
}

function formatItem(item: TwinglyNewsItem): string {
  return `${item.title}\n来源: ${item.source}  时间: ${item.publishTime || '未知'}`
    + `${metadataLine(item)}\n链接: ${item.url}`;
}

export async function runTwinglyForExistingTool(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  if (name === 'finance_news') {
    const query = String(args.query ?? '').trim();
    if (!query) throw new TwinglyClientError('request', 'finance_news 缺少 query');
    const result = await searchTwinglyFinanceNews(query, 20);
    if (result.items.length === 0) {
      throw new TwinglyClientError('empty', 'Twingly 未找到匹配新闻');
    }
    return {
      content: [{
        type: 'text',
        text: `# ${query} 财经新闻搜索结果\n\n${result.items.map(formatItem).join('\n\n---\n\n')}`
          + `\n\n---\nTwingly 估算匹配总数: ${result.estimatedTotal}`,
      }],
    };
  }

  if (name === 'hot_news_7x24') {
    const limit = typeof args.limit === 'number' && Number.isFinite(args.limit)
      ? Math.floor(args.limit)
      : 100;
    const result = await searchTwinglyHotNews(limit);
    if (result.items.length === 0) {
      throw new TwinglyClientError('empty', 'Twingly 最近 24 小时无匹配新闻');
    }
    return {
      content: [{
        type: 'text',
        text: `# 7x24 财经热点\n\n${result.items.map(formatItem).join('\n\n---\n\n')}`
          + `\n\n---\nTwingly 估算匹配总数: ${result.estimatedTotal}`,
      }],
    };
  }

  throw new TwinglyClientError('request', `Twingly 不支持工具 ${name}`);
}

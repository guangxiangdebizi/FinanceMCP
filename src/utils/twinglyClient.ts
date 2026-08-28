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
  requestedSize: number;
  appliedSize: number;
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

function normalizeWebUrl(value: unknown): string {
  const url = String(value ?? '').trim();
  if (!url) return '';
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:' ? url : '';
  } catch {
    return '';
  }
}

function normalizeDocument(document: TwinglyDocument): TwinglyNewsItem | undefined {
  const title = stripMarkup(document.title);
  const url = normalizeWebUrl(document.url);
  if (!title || !url) return undefined;

  return {
    articleId: String(document.article_id ?? ''),
    siteId: String(document.site_id ?? ''),
    title,
    url,
    source: stripMarkup(document.site_name) || 'Twingly',
    siteUrl: normalizeWebUrl(document.site_url),
    sectionName: stripMarkup(document.section_name),
    sectionUrl: normalizeWebUrl(document.section_url),
    publishTime: String(document.published_at ?? document.timestamp ?? '').trim(),
    languageCode: String(document.language_code ?? '').trim().toLowerCase(),
    locationCode: String(document.location_code ?? '').trim().toLowerCase(),
    duplicateCount: Array.isArray(document.identical_documents)
      ? document.identical_documents.length
      : 0,
  };
}

async function postSearch(
  query: Record<string, unknown>,
  requestedSize: number,
  appliedSize: number,
): Promise<TwinglySearchResult> {
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
      requestedSize,
      appliedSize,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function queryTerms(query: string): string[] {
  const normalized = query.trim();
  const terms: string[] = [];
  let current = '';
  let quoted = false;

  const pushCurrent = () => {
    const term = current.trim();
    if (term) terms.push(term);
    current = '';
  };

  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === '\\' && normalized[index + 1] === '"') {
      current += '"';
      index += 1;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (/\s/.test(character) && !quoted) {
      pushCurrent();
      continue;
    }
    current += character;
  }
  pushCurrent();

  if (terms.length === 0) {
    throw new TwinglyClientError('request', 'Twingly search query is empty');
  }
  if (terms.length > 250) {
    throw new TwinglyClientError(
      'request',
      `Twingly News Search supports at most 250 combined terms; received ${terms.length}`,
    );
  }
  return terms;
}

function normalizeRequestedSize(size: number, fallback: number): number {
  return Number.isFinite(size) ? Math.max(1, Math.floor(size)) : fallback;
}

export async function searchTwinglyFinanceNews(query: string, size = 20): Promise<TwinglySearchResult> {
  const now = new Date();
  const requestedSize = normalizeRequestedSize(size, 20);
  const appliedSize = Math.min(250, requestedSize);
  return postSearch({
    all: queryTerms(query),
    size: appliedSize,
    sort: 'timestamp',
    order: 'desc',
    timestamp: {
      since: isoSeconds(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)),
      until: isoSeconds(now),
    },
    group_identical_documents: true,
  }, requestedSize, appliedSize);
}

export async function searchTwinglyHotNews(size = 100): Promise<TwinglySearchResult> {
  const now = new Date();
  const requestedSize = normalizeRequestedSize(size, 100);
  const appliedSize = Math.min(250, requestedSize);
  return postSearch({
    any: HOT_NEWS_TERMS,
    size: appliedSize,
    sort: 'timestamp',
    order: 'desc',
    timestamp: {
      since: isoSeconds(new Date(now.getTime() - 24 * 60 * 60 * 1000)),
      until: isoSeconds(now),
    },
    group_identical_documents: true,
  }, requestedSize, appliedSize);
}

function metadataLine(item: TwinglyNewsItem): string {
  const metadata = [
    item.articleId ? `article_id: ${item.articleId}` : '',
    item.languageCode ? `语言: ${item.languageCode}` : '',
    item.locationCode ? `地区: ${item.locationCode}` : '',
    item.siteId ? `site_id: ${item.siteId}` : '',
    item.siteUrl ? `site_url: ${item.siteUrl}` : '',
    item.sectionName ? `section: ${item.sectionName}` : '',
    item.sectionUrl ? `section_url: ${item.sectionUrl}` : '',
    item.duplicateCount ? `同源重复报道: ${item.duplicateCount}` : '',
  ].filter(Boolean).join('  ');
  return metadata ? `\n${metadata}` : '';
}

function formatItem(item: TwinglyNewsItem): string {
  return `${item.title}\n来源: ${item.source}  时间: ${item.publishTime || '未知'}`
    + `${metadataLine(item)}\n链接: ${item.url}`;
}

function sizeLimitLine(result: TwinglySearchResult): string {
  if (result.requestedSize <= result.appliedSize) return '';
  return `\n\nTwingly result limit: ${result.appliedSize}`
    + ` (requested: ${result.requestedSize}; API maximum: 250)`;
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
          + sizeLimitLine(result)
          + `\n\n---\nTwingly 估算匹配总数: ${result.estimatedTotal}`,
      }],
    };
  }

  throw new TwinglyClientError('request', `Twingly 不支持工具 ${name}`);
}

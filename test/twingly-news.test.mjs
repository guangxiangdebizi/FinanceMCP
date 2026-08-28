import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import {
  getConfiguredCredentialSources,
  QVERIS_CONFIG,
  runWithRequestContext,
  TUSHARE_CONFIG,
  TWINGLY_CONFIG,
} from '../build/config.js';
import { routeToolCall } from '../build/utils/dataSourceRouter.js';

function textOf(result) {
  return (result.content ?? []).map(item => item.text ?? '').join('\n');
}

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  return address.port;
}

test('a request-scoped Twingly key does not inherit shared server credentials', async () => {
  const previousTushare = process.env.TUSHARE_TOKEN;
  const previousQveris = process.env.QVERIS_API_KEY;
  const previousTwingly = process.env.TWINGLY_API_KEY;
  process.env.TUSHARE_TOKEN = 'shared-tushare-token';
  process.env.QVERIS_API_KEY = 'shared-qveris-key';
  process.env.TWINGLY_API_KEY = 'shared-twingly-key';

  try {
    await runWithRequestContext({ twinglyApiKey: 'request-twingly-key' }, async () => {
      assert.deepEqual(getConfiguredCredentialSources(), ['twingly']);
      assert.equal(TUSHARE_CONFIG.API_TOKEN, '');
      assert.equal(QVERIS_CONFIG.API_KEY, '');
      assert.equal(TWINGLY_CONFIG.API_KEY, 'request-twingly-key');
    });
  } finally {
    if (previousTushare === undefined) delete process.env.TUSHARE_TOKEN;
    else process.env.TUSHARE_TOKEN = previousTushare;
    if (previousQveris === undefined) delete process.env.QVERIS_API_KEY;
    else process.env.QVERIS_API_KEY = previousQveris;
    if (previousTwingly === undefined) delete process.env.TWINGLY_API_KEY;
    else process.env.TWINGLY_API_KEY = previousTwingly;
  }
});

test('Twingly routes news, preserves 64-bit IDs, groups duplicates, and never returns article bodies', async () => {
  const requests = [];
  let mode = 'success';
  const mock = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({
      headers: request.headers,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    });
    response.setHeader('Content-Type', 'application/json');

    if (mode === 'auth') {
      response.statusCode = 401;
      response.end(JSON.stringify({ error: 'invalid API key' }));
      return;
    }
    if (mode === 'empty') {
      response.end(JSON.stringify({
        number_of_documents: 0,
        number_of_documents_estimated_total: 0,
        documents: [],
      }));
      return;
    }

    response.end(`{
      "number_of_documents": 2,
      "number_of_documents_estimated_total": 12,
      "documents": [{
        "article_id": 18446744073709551614,
        "site_id": 18446744073709551613,
        "title": "Federal Reserve &amp; markets",
        "url": "https://example.test/article",
        "text": "LICENSED FULL ARTICLE BODY MUST NEVER BE RETURNED",
        "published_at": "2026-08-26T03:00:00Z",
        "timestamp": "2026-08-26T03:01:00Z",
        "language_code": "en",
        "location_code": "us",
        "site_name": "Example Finance",
        "site_url": "https://example.test",
        "section_name": "Markets",
        "section_url": "https://example.test/markets",
        "identical_documents": [{
          "article_id": 18446744073709551612,
          "site_id": 18446744073709551611,
          "title": "Duplicate full body",
          "url": "https://duplicate.test/article",
          "text": "ANOTHER FULL BODY"
        }]
      }, {
        "article_id": 18446744073709551610,
        "site_id": 18446744073709551609,
        "title": "Legacy HTTP article remains valid",
        "url": "http://insecure.example.test/article",
        "text": "LEGACY HTTP FULL BODY MUST NEVER BE RETURNED",
        "published_at": "2026-08-26T03:00:00Z",
        "language_code": "en",
        "location_code": "us",
        "site_name": "Insecure News",
        "identical_documents": []
      }]
    }`);
  });

  const port = await listen(mock);
  const previousBaseUrl = process.env.TWINGLY_BASE_URL;
  process.env.TWINGLY_BASE_URL = `http://127.0.0.1:${port}`;

  try {
    let nativeCalls = 0;
    const success = await runWithRequestContext({
      twinglyApiKey: 'request-scoped-twingly-key',
      sourcePriority: ['twingly', 'qveris', 'tushare', 'binance'],
    }, () => routeToolCall('finance_news', { query: 'Federal Reserve' }, async () => {
      nativeCalls += 1;
      return { content: [{ type: 'text', text: '# public fallback' }] };
    }));

    const successText = textOf(success);
    assert.equal(nativeCalls, 0);
    assert.match(successText, /^数据来源: Twingly/m);
    assert.match(successText, /Federal Reserve & markets/);
    assert.match(successText, /article_id: 18446744073709551614/);
    assert.match(successText, /site_id: 18446744073709551613/);
    assert.match(successText, /site_url: https:\/\/example\.test/);
    assert.match(successText, /section: Markets/);
    assert.match(successText, /section_url: https:\/\/example\.test\/markets/);
    assert.match(successText, /同源重复报道: 1/);
    assert.match(successText, /Legacy HTTP article remains valid/);
    assert.match(successText, /http:\/\/insecure\.example\.test\/article/);
    assert.doesNotMatch(
      successText,
      /LICENSED FULL ARTICLE BODY|ANOTHER FULL BODY|Duplicate full body|LEGACY HTTP FULL BODY/,
    );
    assert.equal(requests[0].headers.authorization, 'apikey request-scoped-twingly-key');
    assert.deepEqual(requests[0].body.all, ['Federal', 'Reserve']);
    assert.equal(requests[0].body.group_identical_documents, true);
    assert.equal(requests[0].body.size, 20);

    await runWithRequestContext({
      twinglyApiKey: 'request-scoped-twingly-key',
      sourcePriority: ['twingly', 'qveris', 'tushare', 'binance'],
    }, () => routeToolCall('finance_news', { query: '"Federal Reserve" inflation' }, async () => {
      nativeCalls += 1;
      return { content: [{ type: 'text', text: '# public fallback' }] };
    }));
    assert.deepEqual(requests.at(-1).body.all, ['Federal Reserve', 'inflation']);

    const thirtyTerms = Array.from({ length: 30 }, (_, index) => `term${index}`).join(' ');
    await runWithRequestContext({
      twinglyApiKey: 'request-scoped-twingly-key',
      sourcePriority: ['twingly', 'qveris', 'tushare', 'binance'],
    }, () => routeToolCall('finance_news', { query: thirtyTerms }, async () => {
      nativeCalls += 1;
      return { content: [{ type: 'text', text: '# public fallback' }] };
    }));
    assert.equal(requests.at(-1).body.all.length, 30);

    mode = 'empty';
    const emptyFallback = await runWithRequestContext({
      twinglyApiKey: 'request-scoped-twingly-key',
      sourcePriority: ['twingly', 'qveris', 'tushare', 'binance'],
    }, () => routeToolCall('finance_news', { query: 'no-match' }, async () => {
      nativeCalls += 1;
      return { content: [{ type: 'text', text: '# public fallback' }] };
    }));
    assert.match(textOf(emptyFallback), /^数据来源: 公开新闻源/m);
    assert.match(textOf(emptyFallback), /Twingly（无匹配数据） → 公开新闻源（成功）/);

    mode = 'auth';
    const authFallback = await runWithRequestContext({
      twinglyApiKey: 'bad-key',
      sourcePriority: ['twingly', 'qveris', 'tushare', 'binance'],
    }, () => routeToolCall('finance_news', { query: 'auth-test' }, async () => {
      nativeCalls += 1;
      return { content: [{ type: 'text', text: '# public fallback after auth failure' }] };
    }));
    assert.match(textOf(authFallback), /Twingly（凭证不可用） → 公开新闻源（成功）/);

    mode = 'success';
    const hotResult = await runWithRequestContext({
      twinglyApiKey: 'request-scoped-twingly-key',
      sourcePriority: ['twingly', 'qveris', 'tushare', 'binance'],
    }, () => routeToolCall('hot_news_7x24', { limit: 500 }, async () => {
      nativeCalls += 1;
      return { content: [{ type: 'text', text: '# native hot-news fallback' }] };
    }));
    const hotRequest = requests.at(-1).body;
    assert.ok(Array.isArray(hotRequest.any));
    assert.ok(hotRequest.any.includes('financial market'));
    assert.ok(hotRequest.any.includes('财经'));
    assert.equal(hotRequest.size, 250);
    assert.match(textOf(hotResult), /Twingly result limit: 250 \(requested: 500; API maximum: 250\)/);
    assert.equal(hotRequest.sort, 'timestamp');
    assert.equal(hotRequest.order, 'desc');
    assert.equal(hotRequest.group_identical_documents, true);
    const since = Date.parse(hotRequest.timestamp.since);
    const until = Date.parse(hotRequest.timestamp.until);
    assert.ok(until - since >= 23 * 60 * 60 * 1000);
    assert.ok(until - since <= 25 * 60 * 60 * 1000);
  } finally {
    if (previousBaseUrl === undefined) delete process.env.TWINGLY_BASE_URL;
    else process.env.TWINGLY_BASE_URL = previousBaseUrl;
    await new Promise(resolve => mock.close(resolve));
  }
});

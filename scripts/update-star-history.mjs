import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const repository = process.env.GITHUB_REPOSITORY || 'guangxiangdebizi/FinanceMCP';
const token = process.env.GITHUB_TOKEN;
const outputPath = process.env.STAR_HISTORY_OUTPUT || 'docs/assets/star-history.svg';

if (!token) {
  throw new Error('GITHUB_TOKEN is required to read repository stargazer timestamps');
}

const apiHeaders = {
  Accept: 'application/vnd.github.star+json',
  Authorization: `Bearer ${token}`,
  'User-Agent': 'FinanceMCP-star-history',
  'X-GitHub-Api-Version': '2022-11-28',
};

async function github(pathname) {
  const response = await fetch(`https://api.github.com${pathname}`, { headers: apiHeaders });
  if (!response.ok) {
    throw new Error(`GitHub API request failed with HTTP ${response.status}`);
  }
  return response;
}

function nextPage(linkHeader) {
  if (!linkHeader) return undefined;
  for (const item of linkHeader.split(',')) {
    const match = item.match(/<([^>]+)>;\s*rel="next"/);
    if (match) return new URL(match[1]).pathname + new URL(match[1]).search;
  }
  return undefined;
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function dateLabel(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 7);
}

function renderSvg(starredAt, createdAt) {
  const width = 920;
  const height = 380;
  const margin = { top: 82, right: 42, bottom: 54, left: 68 };
  const chartWidth = width - margin.left - margin.right;
  const chartHeight = height - margin.top - margin.bottom;
  const now = Date.now();
  const start = Math.min(Date.parse(createdAt), starredAt[0] ?? now);
  const end = Math.max(now, start + 86400000);
  const rangeDays = Math.max(1, (end - start) / 86400000);
  const stepDays = rangeDays > 1095 ? 30 : rangeDays > 365 ? 14 : rangeDays > 120 ? 7 : 1;
  const step = stepDays * 86400000;

  const points = [];
  let starIndex = 0;
  for (let timestamp = start; timestamp < end; timestamp += step) {
    while (starIndex < starredAt.length && starredAt[starIndex] <= timestamp) starIndex += 1;
    points.push({ timestamp, count: starIndex });
  }
  points.push({ timestamp: end, count: starredAt.length });

  const maxCount = Math.max(5, Math.ceil(starredAt.length / 5) * 5);
  const x = timestamp => margin.left + ((timestamp - start) / (end - start)) * chartWidth;
  const y = count => margin.top + chartHeight - (count / maxCount) * chartHeight;
  const linePath = points.map((point, index) => `${index ? 'L' : 'M'} ${x(point.timestamp).toFixed(2)} ${y(point.count).toFixed(2)}`).join(' ');
  const areaPath = `${linePath} L ${x(end).toFixed(2)} ${(margin.top + chartHeight).toFixed(2)} L ${x(start).toFixed(2)} ${(margin.top + chartHeight).toFixed(2)} Z`;

  const yGrid = Array.from({ length: 6 }, (_, index) => {
    const value = Math.round((maxCount * index) / 5);
    const yPos = y(value).toFixed(2);
    return `<line class="grid" x1="${margin.left}" y1="${yPos}" x2="${width - margin.right}" y2="${yPos}"/><text class="axis" x="${margin.left - 14}" y="${Number(yPos) + 4}" text-anchor="end">${value}</text>`;
  }).join('');

  const xGrid = Array.from({ length: 5 }, (_, index) => {
    const timestamp = start + ((end - start) * index) / 4;
    const xPos = x(timestamp).toFixed(2);
    return `<line class="grid" x1="${xPos}" y1="${margin.top}" x2="${xPos}" y2="${margin.top + chartHeight}"/><text class="axis" x="${xPos}" y="${height - 24}" text-anchor="middle">${dateLabel(timestamp)}</text>`;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="title description" viewBox="0 0 ${width} ${height}">
  <title id="title">FinanceMCP GitHub stars over time</title>
  <desc id="description">Cumulative GitHub star history for ${escapeXml(repository)}</desc>
  <defs>
    <linearGradient id="line" x1="0" x2="1"><stop stop-color="#06b6d4"/><stop offset="1" stop-color="#8b5cf6"/></linearGradient>
    <linearGradient id="area" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#8b5cf6" stop-opacity=".30"/><stop offset="1" stop-color="#06b6d4" stop-opacity=".02"/></linearGradient>
  </defs>
  <style>
    .background{fill:#ffffff;stroke:#e2e8f0}.title{fill:#0f172a;font:700 22px ui-sans-serif,system-ui}.subtitle{fill:#64748b;font:13px ui-sans-serif,system-ui}.count{fill:#7c3aed;font:700 28px ui-sans-serif,system-ui}.grid{stroke:#e2e8f0;stroke-width:1}.axis{fill:#64748b;font:12px ui-sans-serif,system-ui}
    @media (prefers-color-scheme:dark){.background{fill:#0f172a;stroke:#334155}.title{fill:#f8fafc}.subtitle,.axis{fill:#94a3b8}.count{fill:#a78bfa}.grid{stroke:#334155}}
  </style>
  <rect class="background" x="1" y="1" width="${width - 2}" height="${height - 2}" rx="18"/>
  <text class="title" x="${margin.left}" y="38">GitHub Stars over time</text>
  <text class="subtitle" x="${margin.left}" y="61">${escapeXml(repository)} · updated ${new Date(now).toISOString().slice(0, 10)}</text>
  <text class="count" x="${width - margin.right}" y="48" text-anchor="end">★ ${starredAt.length}</text>
  ${yGrid}${xGrid}
  <path d="${areaPath}" fill="url(#area)"/>
  <path d="${linePath}" fill="none" stroke="url(#line)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`;
}

const metadataResponse = await github(`/repos/${repository}`);
const metadata = await metadataResponse.json();
const starredAt = [];
let page = `/repos/${repository}/stargazers?per_page=100`;

while (page) {
  const response = await github(page);
  const entries = await response.json();
  for (const entry of entries) {
    const timestamp = Date.parse(entry.starred_at);
    if (Number.isFinite(timestamp)) starredAt.push(timestamp);
  }
  page = nextPage(response.headers.get('link'));
}

starredAt.sort((left, right) => left - right);
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, renderSvg(starredAt, metadata.created_at), 'utf8');
console.log(`Rendered ${starredAt.length} stars to ${outputPath}`);

/**
 * 双色球数据更新脚本
 * 从 500.com 抓取最新开奖数据,更新 data/draws.json
 * 由 GitHub Action 自动运行（每周二、四、日晚 22:00 北京时间）
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', 'data', 'draws.json');

// 计算期号范围：当年全部 + 前一年最后 50 期兜底
function getIssueRange() {
  const now = new Date();
  const y = now.getFullYear();
  const prefix = y % 100; // 当前年份前缀 (e.g. 26 for 2026)
  // 全年约 153 期，加一些余量
  return { start: prefix * 1000 + 1, end: prefix * 1000 + 160 };
}

function fetchPage(start, end) {
  const url = `https://datachart.500.com/ssq/history/newinc/history.php?start=${start}&end=${end}`;
  console.log(`Fetching: ${url}`);
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ssq-tracker/1.0)' } }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        resolve(body);
      });
    }).on('error', reject);
  });
}

function parseHTML(html) {
  // 移除 HTML 注释（避免注释中的 <td> 被匹配）
  html = html.replace(/<!--[\s\S]*?-->/g, '');

  const draws = [];
  // 匹配开奖数据行：<tr class="t_tr1"> ... 期号 ... 6红 ... 1蓝 ... 日期</tr>
  const rowRe = /<tr\s+class="t_tr\d">([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRe.exec(html)) !== null) {
    const row = rowMatch[1];
    // 提取所有 <td...>内容</td>
    const cells = [];
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let tdMatch;
    while ((tdMatch = tdRe.exec(row)) !== null) {
      cells.push(tdMatch[1].replace(/<[^>]+>/g, '').trim());
    }
    if (cells.length < 16) continue;

    const code = cells[0];
    // 校验：期号应为5位数字
    if (!/^\d{5}$/.test(code)) continue;

    const reds = [];
    for (let i = 1; i <= 6; i++) {
      const n = parseInt(cells[i], 10);
      if (isNaN(n) || n < 1 || n > 33) { reds.length = 0; break; }
      reds.push(n);
    }
    if (reds.length !== 6) continue;

    const blue = parseInt(cells[7], 10);
    if (isNaN(blue) || blue < 1 || blue > 16) continue;

    // cells[15] = 开奖日期
    const date = cells[15];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;

    draws.push({
      code: code,
      date: date,
      reds: reds.sort((a, b) => a - b),
      blue: blue,
    });
  }
  return draws;
}

function loadExisting() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (e) { /* ignore */ }
  return { version: 1, updatedAt: null, draws: [] };
}

function save(data) {
  data.updatedAt = new Date().toISOString();
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
  console.log(`Saved ${data.draws.length} draws to ${DATA_FILE}`);
}

async function main() {
  const existing = loadExisting();
  const existingMap = new Map(existing.draws.map(d => [d.code, d]));

  const { start, end } = getIssueRange();
  console.log(`Issue range: ${start} - ${end}`);

  const html = await fetchPage(start, end);
  const fetched = parseHTML(html);
  console.log(`Fetched ${fetched.length} draws from 500.com`);

  // 合并：新数据优先
  let newCount = 0;
  for (const d of fetched) {
    if (!existingMap.has(d.code)) {
      existingMap.set(d.code, d);
      newCount++;
    }
  }

  existing.draws = Array.from(existingMap.values())
    .sort((a, b) => b.code.localeCompare(a.code));
  existing.version = 1;

  console.log(`Total: ${existing.draws.length} draws (${newCount} new)`);
  save(existing);
}

main().catch(err => {
  console.error('Update failed:', err);
  process.exit(1);
});

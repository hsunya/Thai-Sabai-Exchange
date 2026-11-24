// 抓取四個來源的匯率，輸出成 site/data/rates.json 給靜態網頁讀取。
// 由 GitHub Actions 定時執行 (.github/workflows/update-rates.yml)，也可以在本機跑：
//   node scripts/fetch-rates.mjs
//
// GitHub Pages 是純靜態網站，瀏覽器直接呼叫這些 API 會被 CORS 擋下 (只有 TT Exchange 允許)，
// 所以改成在伺服器端 (Actions) 抓好資料，網頁只讀同網域的 JSON。
//
// 某個來源失敗時保留上一次成功的數值 (stale)，並記錄失敗原因，不會讓整頁變成空白。
// 上一次的資料來源：環境變數 PREVIOUS_RATES_URL (已部署的 rates.json) 或本機現有的 rates.json。

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = join(ROOT, 'site', 'data', 'rates.json');
const TIMEOUT_MS = 15000;

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ---------------------------------------------------------------- 共用

async function request(url, options = {}) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  return body;
}

function parseJson(body, name) {
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`${name} 回應不是 JSON：${body.slice(0, 120)}`);
  }
}

function toNumber(value, label) {
  const n = typeof value === 'number' ? value : parseFloat(String(value ?? '').replace(/,/g, ''));
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${label} 不是有效數字：${value}`);
  }
  return n;
}

// 面額統一成 "100"、"2,000-100" 的格式 (各家寫法不同：USD (100)、2000 - 100、100-50)
function normalizeDenom(text) {
  if (!text) return null;
  return String(text)
    .replace(/^[A-Z]{3}(\(L\))?\s*/, '')
    .replace(/[()]/g, '')
    .replace(/\s*-\s*/g, '-')
    .replace(/\d{4,}/g, (n) => Number(n).toLocaleString('en-US'))
    .trim() || null;
}

// 美金各面額匯率表：[{ denom: "20-10", min: 10, max: 20, buy: 33.68 }, ...]，由大面額排到小面額。
// 網頁依每張鈔票面額找對應的一筆計算 (site/js/calc.js)。同一面額重複出現時取第一筆。
function buildUsdTiers(entries) {
  const seen = new Set();
  const tiers = [];
  for (const { denom, buy } of entries) {
    const label = normalizeDenom(denom);
    const rate = parseFloat(String(buy ?? '').replace(/,/g, ''));
    const nums = (label ?? '').replace(/,/g, '').match(/\d+/g)?.map(Number) ?? [];
    if (!label || seen.has(label) || !Number.isFinite(rate) || rate <= 0 || nums.length === 0) continue;
    seen.add(label);
    tiers.push({ denom: label, min: Math.min(...nums), max: Math.max(...nums), buy: rate });
  }
  tiers.sort((a, b) => b.max - a.max);
  return tiers;
}

function describeError(err) {
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
    return `連線逾時 (${TIMEOUT_MS / 1000} 秒)`;
  }
  const cause = err?.cause;
  if (cause?.code) {
    return `${err.message} (${cause.code}${cause.message ? ': ' + cause.message : ''})`;
  }
  return err?.message ?? String(err);
}

// ---------------------------------------------------------------- 各來源

// 蘇凡納布機場 Happy Rich (Location 32)
async function fetchHappyRich() {
  const body = await request('https://www.happyrich.co.th/Rate/GetRateService', {
    method: 'POST',
    headers: {
      'User-Agent': CHROME_UA,
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    },
    body: new URLSearchParams({ Language: 'TH', Location: '32' }),
  });
  const json = parseJson(body, 'Happy Rich');
  const list = Array.isArray(json?.data) ? json.data : [];
  // id 2 = 美金 (100 面額)、id 87 = 台幣
  const usd = list.find((d) => d.id === 2);
  const twd = list.find((d) => d.id === 87);
  if (!usd || !twd) {
    throw new Error('找不到 USD (id=2) 或 TWD (id=87)');
  }

  // update_str 是泰國佛曆：dd/MM/yyyy HH:mm:ss，年份減 543 = 西元
  let updatedAt = usd.update_str ?? null;
  const m = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})/.exec(usd.update_str ?? '');
  if (m) {
    updatedAt = `${Number(m[3]) - 543}-${m[2]}-${m[1]} ${m[4]}:${m[5]}`;
  }

  return {
    usdBuy: toNumber(usd.buyPrice, 'USD 買價'),
    twdBuy: toNumber(twd.buyPrice, 'TWD 買價'),
    usdDenom: normalizeDenom(usd.currencyDenom),
    twdDenom: normalizeDenom(twd.currencyDenom),
    usdTiers: buildUsdTiers(list
      .filter((d) => d.currencyCode === 'USD')
      .map((d) => ({ denom: d.currencyDenom, buy: d.buyPrice }))),
    updatedAt,
  };
}

// 曼谷水門市場 Super Rich (總行 H01，branchId=10)
async function fetchSuperRich() {
  const body = await request('https://api.superrichthailand.com/api/v1/exchange-client/list?branchId=10&type=exchange', {
    headers: { 'Accept': 'application/json' },
  });
  const json = parseJson(body, 'Super Rich');
  const exchange = json?.data?.exchange;
  // 不存在的 branchId 一樣回 SUCCESS，只是 exchange 是空的
  if (json?.code !== 'SUCCESS' || !exchange || Object.keys(exchange).length === 0) {
    throw new Error(`API 沒有回傳匯率資料 (code=${json?.code}, message=${json?.message})`);
  }

  // 同幣別有多種面額，面額越大匯率越好，取 denomRem 開頭數字最大的一筆
  const largest = (unit) => {
    const rates = (exchange[unit] ?? []).filter((r) => parseFloat(r.buyText) > 0);
    rates.sort((a, b) => (parseInt(b.denomRem, 10) || 0) - (parseInt(a.denomRem, 10) || 0));
    return rates[0];
  };
  const usd = largest('USD');
  const twd = largest('TWD');
  if (!usd || !twd) {
    throw new Error('找不到 USD 或 TWD');
  }

  // time.time 是當日每次調價的時間 (泰國時間)，取最晚的一筆
  const times = (json.data.time?.time ?? []).filter(Boolean).sort();
  const latest = times[times.length - 1];

  return {
    usdBuy: toNumber(usd.buyText, 'USD 買價'),
    twdBuy: toNumber(twd.buyText, 'TWD 買價'),
    usdDenom: normalizeDenom(usd.denomRem),
    twdDenom: normalizeDenom(twd.denomRem),
    usdTiers: buildUsdTiers((exchange.USD ?? []).map((r) => ({ denom: r.denomRem, buy: r.buyText }))),
    updatedAt: json.data.time?.date ? `${json.data.time.date}${latest ? ' ' + latest : ''}` : null,
  };
}

// 芭達雅 Terminal 21 T.T. Exchange
async function fetchTT() {
  const [ratesBody, timeBody] = await Promise.all([
    request('https://api.software.ttexchange.com/currencies?is_main=false&branch_id=21'),
    request('https://api.software.ttexchange.com/currencies/updated_at?branch_id=21'),
  ]);
  const list = parseJson(ratesBody, 'TT Exchange');
  // id 1 = USD(L) 100-50、id 2 = USD(M) 20-5、id 3 = USD(S) 2-1、id 25 = TWD
  const usd = Array.isArray(list) ? list.find((d) => d.id === 1) : null;
  const twd = Array.isArray(list) ? list.find((d) => d.id === 25) : null;
  if (!usd || !twd) {
    throw new Error('找不到 USD (id=1) 或 TWD (id=25)');
  }

  // updated_at 例如 2026-11-24T14:06:00.586+07:00，直接取泰國當地時間
  const updated = parseJson(timeBody, 'TT Exchange 更新時間')?.updated_at ?? '';
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(updated);

  return {
    usdBuy: toNumber(usd.current_buy_rate, 'USD 買價'),
    twdBuy: toNumber(twd.current_buy_rate, 'TWD 買價'),
    usdDenom: normalizeDenom(usd.description),
    twdDenom: normalizeDenom(twd.description),
    usdTiers: buildUsdTiers(list
      .filter((d) => d.currency_group_id === usd.currency_group_id)
      .map((d) => ({ denom: d.description, buy: d.current_buy_rate }))),
    updatedAt: m ? `${m[1]} ${m[2]}` : updated || null,
  };
}

// 臺灣銀行牌告匯率 (美金現金賣出)
async function fetchBankOfTaiwan() {
  // 台銀前面有 Radware Bot 防護，判斷依據是整組瀏覽器標頭是否齊全；
  // Node 的 fetch 會自動送出 Accept-Encoding 並解壓回應
  const body = await request('https://rate.bot.com.tw/xrt?Lang=zh-TW', {
    headers: {
      'User-Agent': CHROME_UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
    },
  });

  if (body.includes('Challenge Validation') || body.includes('sec-cpt-if')) {
    throw new Error('被台銀 Bot 防護 (Radware) 攔截，回傳的是 Challenge Validation 挑戰頁');
  }

  const time = /<span class="time">\s*([^<]+?)\s*<\/span>/.exec(body);
  // 第一列是美金，取第一個「本行現金賣出」
  const sell = /<td[^>]*data-table="本行現金賣出"[^>]*>\s*([\d.]+)/.exec(body);
  if (!time || !sell) {
    throw new Error('找不到掛牌時間或本行現金賣出，台銀可能改版');
  }

  return {
    usdCashSell: toNumber(sell[1], '美金現金賣出'),
    updatedAt: time[1].replace(/\//g, '-'),
  };
}

// ---------------------------------------------------------------- 主程式

const SOURCES = {
  happyrich: fetchHappyRich,
  superrich: fetchSuperRich,
  tt: fetchTT,
  bot: fetchBankOfTaiwan,
};

async function loadPrevious() {
  const url = process.env.PREVIOUS_RATES_URL;
  if (url) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.ok) {
        return await res.json();
      }
      console.log(`上一次的資料：${url} 回 HTTP ${res.status} (第一次部署是正常的)`);
    } catch (err) {
      console.log(`上一次的資料：讀取 ${url} 失敗 (${describeError(err)})`);
    }
  }
  try {
    return JSON.parse(await readFile(OUTPUT, 'utf8'));
  } catch {
    return null;
  }
}

const previous = await loadPrevious();
const now = new Date().toISOString();
const result = { generatedAt: now, sources: {} };

await Promise.all(Object.entries(SOURCES).map(async ([key, fetcher]) => {
  const prev = previous?.sources?.[key];
  try {
    const data = await fetcher();
    result.sources[key] = { ok: true, stale: false, ...data, fetchedAt: now, lastSuccessAt: now, error: null };
    console.log(`OK    ${key}`, JSON.stringify(data));
  } catch (err) {
    const error = describeError(err);
    console.log(`FAIL  ${key}  ${error}`);
    // 保留上一次成功的數值，標記為 stale
    result.sources[key] = prev?.lastSuccessAt
      ? { ...prev, ok: false, stale: true, fetchedAt: now, error }
      : { ok: false, stale: false, fetchedAt: now, lastSuccessAt: null, error };
  }
}));

// 固定輸出順序
result.sources = Object.fromEntries(Object.keys(SOURCES).map((k) => [k, result.sources[k]]));

await mkdir(dirname(OUTPUT), { recursive: true });
await writeFile(OUTPUT, JSON.stringify(result, null, 2) + '\n', 'utf8');
console.log(`已寫入 ${OUTPUT}`);

// 全部失敗而且也沒有舊資料可用時，讓 Actions 顯示失敗
if (Object.values(result.sources).every((s) => !s.ok && !s.stale)) {
  process.exitCode = 1;
}

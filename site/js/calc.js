// 換匯計算與距離計算的純函式 (不碰 DOM)。
// 瀏覽器：<script src="js/calc.js"> 後以 window.ThaiCalc 使用。
// Node 測試：require('./site/js/calc.js') 或 createRequire 載入 (tests/calc.test.mjs)。
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.ThaiCalc = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 美金現行常見紙鈔 (不含少見的 2 元鈔；硬幣兌換所不收)
  var USD_BILLS = [100, 50, 20, 10, 5, 1];
  // 泰國兌換所收的台幣最小面額是 100 元紙鈔 (各家公告面額 2,000-100 / 1,000-100)
  var TWD_MIN_BILL = 100;
  var MAX_AMOUNT = 100000000; // 一億，避免極大數值造成顯示或浮點問題

  function round2(n) { return Math.round(n * 100) / 100; }

  // ---------------------------------------------------------------- 輸入驗證

  // 回傳 { ok, value, error }；error 為 'empty' | 'nan' | 'negative' | 'zero' | 'too-large'
  function parseAmount(raw) {
    var s = String(raw == null ? '' : raw).replace(/,/g, '').trim();
    if (s === '') return { ok: false, value: 0, error: 'empty' };
    var n = Number(s);
    if (!Number.isFinite(n)) return { ok: false, value: 0, error: 'nan' };
    if (n < 0) return { ok: false, value: 0, error: 'negative' };
    if (n === 0) return { ok: false, value: 0, error: 'zero' };
    if (n > MAX_AMOUNT) return { ok: false, value: 0, error: 'too-large' };
    return { ok: true, value: n, error: null };
  }

  // ---------------------------------------------------------------- 面額

  // "20-10" → { min: 10, max: 20 }；"100" → { min: 100, max: 100 }；"2,000-100" → { min: 100, max: 2000 }
  function parseDenomRange(text) {
    if (text == null) return null;
    var nums = String(text).replace(/,/g, '').match(/\d+(\.\d+)?/g);
    if (!nums || nums.length === 0) return null;
    var values = nums.map(Number);
    return { min: Math.min.apply(null, values), max: Math.max.apply(null, values) };
  }

  // 取得某來源的美金面額匯率表。
  // 新版 rates.json 有 usdTiers；舊資料 (沿用時可能出現) 只有 usdBuy + usdDenom，
  // 此時只把 usdBuy 套用在 usdDenom 範圍內的面額，其他面額視為沒有資料。
  function usdTiersOf(src) {
    if (!src) return [];
    if (Array.isArray(src.usdTiers) && src.usdTiers.length) {
      return src.usdTiers.filter(function (t) {
        return t && Number(t.buy) > 0 && Number.isFinite(t.min) && Number.isFinite(t.max);
      });
    }
    var range = parseDenomRange(src.usdDenom);
    if (range && Number(src.usdBuy) > 0) {
      return [{ denom: src.usdDenom, min: range.min, max: range.max, buy: Number(src.usdBuy) }];
    }
    return [];
  }

  // 某張美金紙鈔適用的買價；找不到對應面額回傳 null (不自行套用其他面額的匯率)
  function usdRateForBill(tiers, bill) {
    for (var i = 0; i < tiers.length; i++) {
      if (bill >= tiers[i].min && bill <= tiers[i].max) return tiers[i].buy;
    }
    return null;
  }

  // 整數美金以最少張數拆成紙鈔 → { 100: n, 50: n, ... }
  function splitUsdBills(usd) {
    var rest = Math.floor(Math.max(0, usd));
    var counts = {};
    USD_BILLS.forEach(function (bill) {
      counts[bill] = Math.floor(rest / bill);
      rest -= counts[bill] * bill;
    });
    return counts;
  }

  function sumBills(counts) {
    return USD_BILLS.reduce(function (sum, bill) {
      return sum + bill * (Number(counts && counts[bill]) || 0);
    }, 0);
  }

  // ---------------------------------------------------------------- 換算路線

  // 美金現鈔 → 泰銖，依每張鈔票面額套用對應匯率。
  // 回傳 { thb, usdCounted, usdMissing, lines: [{ bill, count, rate, thb }], missingBills: [bill] }
  function usdBillsToThb(counts, tiers) {
    var result = { thb: 0, usdCounted: 0, usdMissing: 0, lines: [], missingBills: [] };
    USD_BILLS.forEach(function (bill) {
      var count = Math.floor(Number(counts && counts[bill]) || 0);
      if (count <= 0) return;
      var rate = usdRateForBill(tiers, bill);
      if (rate == null) {
        result.usdMissing += bill * count;
        result.missingBills.push(bill);
        return;
      }
      var thb = bill * count * rate;
      result.thb += thb;
      result.usdCounted += bill * count;
      result.lines.push({ bill: bill, count: count, rate: rate, thb: thb });
    });
    return result;
  }

  // 台幣現鈔直接換泰銖。未滿 NT$100 的零頭兌換所不收。
  function twdDirect(twd, twdBuy) {
    if (!(twdBuy > 0)) return null;
    var amount = Math.max(0, twd);
    // +1e-9：避免 1699.9999999 這類浮點誤差少算一張 100 元
    var exchanged = Math.floor(amount / TWD_MIN_BILL + 1e-9) * TWD_MIN_BILL;
    return { thb: exchanged * twdBuy, twdExchanged: exchanged, twdLeft: round2(Math.max(0, amount - exchanged)) };
  }

  // 先在臺灣銀行用台幣買美金 100 元大鈔，到泰國換泰銖；
  // 買不滿一張 100 元的台幣餘額，在同一家兌換所直接換台幣 (同樣只收 NT$100 以上紙鈔)。
  // 只用 100 元大鈔估算：台銀實際能拿到哪些面額沒有可靠資料，而 100 元在泰國的匯率最好。
  function twdViaUsd(twd, usdCashSell, tiers, twdBuy) {
    if (!(usdCashSell > 0)) return { ok: false, reason: 'no-bot' };
    var rate100 = usdRateForBill(tiers, 100);
    if (rate100 == null) return { ok: false, reason: 'no-usd-rate' };
    var amount = Math.max(0, twd);
    var costPerBill = round2(100 * usdCashSell); // 100 × 33.21 在浮點數是 3321.0000000000005
    var bills = Math.floor(amount / costPerBill + 1e-9);
    if (bills < 1) return { ok: false, reason: 'not-enough', costPerBill: costPerBill };

    var twdSpent = round2(bills * costPerBill);
    var remainder = round2(Math.max(0, amount - twdSpent));
    var rest = twdDirect(remainder, twdBuy);
    var thbFromUsd = bills * 100 * rate100;
    var thbFromTwd = rest ? rest.thb : 0;
    return {
      ok: true,
      bills: bills,
      usd: bills * 100,
      rate100: rate100,
      twdSpent: twdSpent,
      twdRemainder: remainder,
      twdRemainderExchanged: rest ? rest.twdExchanged : 0,
      twdLeft: rest ? rest.twdLeft : remainder,
      thbFromUsd: thbFromUsd,
      thbFromTwd: thbFromTwd,
      thb: thbFromUsd + thbFromTwd,
      // 舊版的理論值 (台幣全額換成可分割的美金)，僅供對照
      theoreticalThb: amount / usdCashSell * rate100
    };
  }

  // ---------------------------------------------------------------- 距離

  var EARTH_RADIUS_KM = 6371.0088;

  function isValidCoord(lat, lng) {
    return typeof lat === 'number' && typeof lng === 'number' &&
      Number.isFinite(lat) && Number.isFinite(lng) &&
      lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 &&
      !(lat === 0 && lng === 0);
  }

  // Haversine 直線距離 (公里)
  function haversineKm(lat1, lng1, lat2, lng2) {
    var toRad = function (d) { return d * Math.PI / 180; };
    var dLat = toRad(lat2 - lat1);
    var dLng = toRad(lng2 - lng1);
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  // Google Maps 導航網址 (官方 Maps URLs 格式，不需要 API Key)。
  // 不帶起點：由 Google Maps 自行使用使用者目前位置，座標不會出現在網址裡。
  function directionsUrl(lat, lng) {
    return 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(lat + ',' + lng);
  }

  return {
    USD_BILLS: USD_BILLS,
    TWD_MIN_BILL: TWD_MIN_BILL,
    MAX_AMOUNT: MAX_AMOUNT,
    parseAmount: parseAmount,
    parseDenomRange: parseDenomRange,
    usdTiersOf: usdTiersOf,
    usdRateForBill: usdRateForBill,
    splitUsdBills: splitUsdBills,
    sumBills: sumBills,
    usdBillsToThb: usdBillsToThb,
    twdDirect: twdDirect,
    twdViaUsd: twdViaUsd,
    isValidCoord: isValidCoord,
    haversineKm: haversineKm,
    directionsUrl: directionsUrl
  };
});

# 泰銖換匯比價

帶台幣或美金去泰國，在哪裡換泰銖最划算？

比較曼谷三家兌換所的台幣、美金買價，加上「先在臺灣銀行換美金、再到泰國換泰銖」的路線，輸入台幣或美金金額就幫你排出哪一種換法拿到最多泰銖；也可以按「使用目前位置」，從 80 多家官方公布的分店中找附近的兌換所，用各分店自己的匯率估算並開啟 Google Maps 導航。

## 功能

- **台幣／美金模式**：切換持有的貨幣。美金模式依每張鈔票的面額，分別套用各家公告的面額匯率（可自行輸入各面額張數）。
- **經台銀換美金**：以台銀美金現金賣出價買整數張 100 元大鈔估算；買不滿一張的餘額在同一家兌換所直接換台幣。泰國兌換所不收硬幣，未滿 NT$100、US$1 的零頭不計。
- **分店資料**：Super Rich 26 家、T.T. Exchange 54 家由官方 API 匯入（地址、座標、營業時間），Happy Rich 蘇凡納布分店為手動維護。每家分店使用**自己的公告匯率**估算，抓不到時顯示「此分店匯率暫無資料」，不會借用其他分店的匯率。
- **附近兌換所**：只在使用者按下按鈕時呼叫一次瀏覽器定位（不使用 `watchPosition`），座標只存在頁面記憶體，不上傳、不寫入 localStorage／Cookie／網址。以 Haversine 計算**直線距離**，可選 1／3／5／10 公里或不限範圍、依距離或預估泰銖排序、依地區篩選。拒絕或定位失敗時，匯率比較照常使用。
- **導航**：使用 Google Maps URL (`/maps/dir/?api=1&destination=緯度,經度`)，不需要 API Key。
- **營業狀態**：依官網公布的營業時間與泰國時間顯示「營業中／未營業」，可排序「目前營業中優先」；沒有查證資料時一律顯示「營業資訊未確認」，不推測。
- **距離與換匯效益**：定位後顯示各分店與最近分店的預估差額；可在每家分店填寫自己的交通費（選填，只存在記憶體），差額會改用扣除交通費後的金額。
- **過期提示**：匯率資料超過 2 小時沒有更新（排程停擺）時，頁面頂端顯示警告，不會把舊資料當成即時匯率。

| 來源 | 位置 | 匯率 |
|---|---|---|
| Super Rich | 曼谷 水門市場（總行） | 美金、台幣買價 |
| Happy Rich | 蘇凡納布機場 | 美金、台幣買價 |
| T.T. Exchange | 芭達雅 Terminal 21 | 美金、台幣買價 |
| 臺灣銀行 | 牌告匯率 | 美金現金賣出 |

## 運作方式

GitHub Pages 只能放靜態網頁，而這幾個網站的 API 大多不允許瀏覽器跨網域呼叫（CORS），所以由 **GitHub Actions** 每 30 分鐘在伺服器端抓一次匯率，產生 `data/rates.json`，再連同網頁一起部署到 GitHub Pages。網頁本身只讀取同網域的 JSON。

```
GitHub Actions (每 30 分鐘)
  └─ scripts/fetch-rates.mjs  抓取 4 個來源
       └─ site/data/rates.json
            └─ 部署 site/ 到 GitHub Pages ──▶ index.html 讀取 rates.json
```

某個來源暫時抓不到時，會沿用線上那份 `rates.json` 裡上一次成功的數值，網頁上標示「沿用 xx:xx 的資料」並可展開失敗原因。

## 檔案結構

```
.github/workflows/update-rates.yml   排程抓取 + 部署
scripts/fetch-rates.mjs              抓取匯率 (代表來源 + 各分店)，排程執行 (Node 22，無任何相依套件)
scripts/build-shops.mjs              從官方 API 產生分店資料，手動執行
site/index.html                      網頁 (畫面與互動，無外部函式庫)
site/js/calc.js                      換匯、面額、距離計算的純函式 (瀏覽器與 Node 共用)
site/data/rates.json                 匯率資料 (由腳本產生)
site/data/exchange-shops.json        兌換所分店資料 (build-shops.mjs 產生 + 手動項目)
tests/calc.test.mjs                  計算與分店資料的測試
```

### rates.json 欄位

每個兌換所來源除了 `usdBuy`、`twdBuy`（最大面額）之外，還有 `usdTiers`：美金各面額買價，例如

```json
[{ "denom": "100", "min": 100, "max": 100, "buy": 33.83 }, { "denom": "20-10", "min": 10, "max": 20, "buy": 33.77 }]
```

`branchRates` 以分店的 `rateKey`（例如 `superrich:28`、`tt:16`、`happyrich:32`）為 key，欄位與 `sources` 相同；T.T. 分店不另外請求更新時間，`updatedAt` 為 `null`，網頁改顯示抓取時間。與代表來源相同的分店（`superrich:10`、`tt:21`、`happyrich:32`）直接沿用，不重複請求；分店匯率以每次最多 4 個請求並行抓取。

網頁依每張鈔票面額找 `min ≤ 面額 ≤ max` 的那一筆計算；找不到對應面額時不套用其他面額的匯率，而是標示「沒有面額匯率，未計入」。舊資料沒有 `usdTiers` 時，只把 `usdBuy` 用在 `usdDenom` 的面額範圍。

### exchange-shops.json 欄位

| 欄位 | 說明 |
|---|---|
| `id` | 唯一識別碼 |
| `brand`、`branchName` | 品牌與分店名稱 |
| `city` | 地區篩選用的大範圍分區：距曼谷市中心 45 公里內為「曼谷都會區」、距芭達雅市中心 20 公里內為「芭達雅一帶」，其餘依地址關鍵字 |
| `area` | 商場／區域名稱 |
| `address` | 完整地址；**未查證時為 `null`** |
| `latitude`、`longitude` | 分店座標 |
| `openingHours` | 泰國時間，例如 `{ "monday": "09:00-18:00", "sunday": "closed" }`；缺少的日子視為未確認；**未查證時為 `null`**，網頁顯示「營業資訊未確認」 |
| `openingHoursNote` | 營業時間補充，例如國定假日的時間 |
| `phone` | 電話；未查證時為 `null` |
| `supportedCurrencies` | 可兌換的貨幣 |
| `rateKey` | 對應 `rates.json` 的 `branchRates` key |
| `dataSource` | `superrich-api`、`tt-api` 由腳本產生；`manual` 為手動維護，重新產生時會保留 |
| `rateScope`、`rateScopeNote` | 匯率適用範圍說明（是否為該分店本身的報價） |
| `googleMapsUrl` | Google Maps 地點連結 |
| `lastVerifiedAt`、`verification` | 最後查證日期與查證來源 |

更新分店資料（地址、營業時間很少變動，不放進排程）：

```bash
node scripts/build-shops.mjs
```

執行後檢查 `git diff` 再 commit。官方資料格式不明的欄位會留空，例如營業日寫成 `6.7` 的那幾天視為未確認；沒有座標的分店不收錄。手動新增分店時在 `branches` 加一筆、`dataSource` 設為 `manual`，不用改程式；沒有可靠來源的欄位填 `null`，不要猜測。


## 部署到自己的 GitHub

1. 建立一個新的 **public** repository，把這個資料夾的內容放在 repo 根目錄後 push 到 `main` 分支。
2. 到 repo 的 **Settings → Pages → Build and deployment → Source** 選 **GitHub Actions**。
3. 到 **Actions** 頁面，選「更新匯率並部署」→ **Run workflow** 手動跑第一次。
4. 完成後網址是 `https://<帳號>.github.io/<repo 名稱>/`。

之後每 30 分鐘會自動更新；push 到 `main` 也會立即重新部署。

## 本機測試

```bash
node scripts/fetch-rates.mjs
```

```bash
python -m http.server 8080 --directory site
```

開啟 http://localhost:8080 。（直接雙擊 `index.html` 會因為瀏覽器禁止 `file://` 讀取 JSON 而載入失敗，需要透過本機伺服器開啟。定位功能只能在 HTTPS 或 `localhost` 下使用。）

執行測試（Node 22 內建 test runner，不需安裝套件）：

```bash
node --test tests/calc.test.mjs
```

## 注意事項

- **匯率僅供參考**，所有換算都是預估，實際以各兌換所現場公告為準。
- 分店地址與營業時間取自各家官方來源（Super Rich 官網分店資料、Happy Rich 官網聯絡頁、T.T. Exchange 官方 stores API），查證日期記錄在 `lastVerifiedAt`。營業時間可能異動，國定假日或臨時公休不在判斷範圍內。距離是直線距離，不是路線距離。
- 公開 repository 如果 **60 天沒有任何 commit**，GitHub 會自動停用排程，需要到 Actions 頁面重新啟用。
- 臺灣銀行網站前面有 Bot 防護。GitHub Actions 的執行環境是海外機房 IP，可能被判定為機器人流量而抓不到；此時網頁會沿用上一次成功的資料，並在台銀卡片上顯示失敗原因。
- 各來源的 API 隨時可能改版，抓取失敗時請到 Actions 的執行紀錄查看「抓取匯率」步驟的輸出。

# 泰銖換匯比價

帶台幣或美金去泰國，在哪裡換泰銖最划算？

比較曼谷三家兌換所的台幣、美金買價，加上「先在臺灣銀行換美金、再到泰國換泰銖」的路線，輸入台幣金額就幫你排出哪一種換法拿到最多泰銖。

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
scripts/fetch-rates.mjs              抓取腳本 (Node 22，無任何相依套件)
site/index.html                      網頁 (單一檔案，無外部函式庫)
site/data/rates.json                 匯率資料 (由腳本產生)
```

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

開啟 http://localhost:8080 。（直接雙擊 `index.html` 會因為瀏覽器禁止 `file://` 讀取 JSON 而載入失敗，需要透過本機伺服器開啟。）

## 注意事項

- **匯率僅供參考**，實際以各兌換所現場公告為準。兌換所匯率取最大面額，小面額鈔票匯率較差。
- 公開 repository 如果 **60 天沒有任何 commit**，GitHub 會自動停用排程，需要到 Actions 頁面重新啟用。
- 臺灣銀行網站前面有 Bot 防護。GitHub Actions 的執行環境是海外機房 IP，可能被判定為機器人流量而抓不到；此時網頁會沿用上一次成功的資料，並在台銀卡片上顯示失敗原因。
- 各來源的 API 隨時可能改版，抓取失敗時請到 Actions 的執行紀錄查看「抓取匯率」步驟的輸出。

# 永續合約熱度看板

使用者是台灣的銀行法金 ARM，總經研究背景，用這個網站輔助自己的加密貨幣永續合約交易判斷。
以繁體中文溝通；市場術語保留英文。

## 這個專案是什麼

前端網站，以一支 Cloudflare Worker 提供，顯示幣安、OKX 兩間交易所 USDT 永續合約的報價、成交額熱力圖，
以及四個動能指標（15 分鐘漲跌、15 分鐘 RVOL、OI 變化、主動買賣比），外加 CoinGecko 熱搜。手機與桌機並重。
使用者之後要做的是動能策略，這些指標是為了那個策略與第二階段回測準備的。

**Pionex 區塊目前關閉**（使用者 2026-11-15 決定）：Pionex 拒絕 Cloudflare Workers 的請求，要等使用者另外準備主機放轉接。
`src/exchanges/pionex.ts`、`server/pionexProxy.ts` 與相關測試都保留著（Pionex 只接了 K 線，沒有 OI 與買賣比）。恢復時：把轉接部署到非 Cloudflare 的主機、
建置時設 `VITE_PIONEX_BASE` 指向它（轉接要加 CORS 標頭）、在 `src/exchanges/index.ts` 把 `pionex` 加回 `ADAPTERS`、
在 `src/App.tsx` 加回分頁與 `useExchange` 呼叫。

- 幣種範圍：每間交易所 24 小時成交額前 50 名的 USDT 永續合約。
- 熱力圖四種模式：RVOL（預設）、OI 變化、買賣比、24 小時漲跌。方塊面積是成交額的開根號比例。
- 四個動能指標都描述同一根「最近收盤的 15 分鐘 K 棒」，定義在 `src/lib/metrics.ts`：
  - 15m：該 K 棒開盤到收盤的漲跌。
  - RVOL：該 K 棒成交額 ÷ 前 3 天（288 根）15 分鐘 K 棒成交額的中位數；基準不足 48 根不顯示。
  - OI 變化：未平倉量（幣數，不用美元值，避免混入價格變動）在該 K 棒期間的變化；明細另有近 1 小時。
    交易所還沒公布收盤那筆快照時，退一根用前一筆，畫面會註明。
  - 買賣比：該 K 棒內主動買入成交額 ÷ 主動賣出成交額。
- 價格與成交額用輪詢，每 5 秒一次；看不到的分頁每 60 秒一次；頁面在背景時停止。
  動能指標在每根 15 分鐘 K 棒收盤後重抓（每間交易所每檔 2–3 個請求）。

## 硬線

1. **不下單、不碰帳戶。** 只讀公開行情。不寫任何下單、撤單、劃轉的程式，不接需要金鑰的 API。
2. **金鑰與密碼不進 repo、不進對話。** 這個 repo 是公開的。
3. **轉接只放行唯讀的公開行情，而且白名單寫死。** 要新增任何轉接端點先問使用者。目前的白名單：
   - OKX（`server/okxStats.ts`，線上運作中）：`/api/okx/oi` 與 `/api/okx/taker`，只接受 GET，
     唯一可帶的參數是 `instId`，且必須是 `XXX-USDT-SWAP`。上游路徑與其他參數都寫死。
   - Pionex（`server/pionexProxy.ts`，目前未接上）：`market/tickers` 與 `market/klines` 的 GET。

## 資料紀律

- **失敗要大聲。** 連線中斷時明確標示「資料停在幾點幾分」並把舊資料調暗，不讓舊報價看起來像即時。
- **「查無」和「查詢失敗」分開。** 例如「這個幣沒進前 50」和「這間交易所連不上」是兩種狀態，不能顯示成同一句。
  每個動能指標都有四種狀態：算出、計算中、資料不足、抓取失敗。熱力圖上「無資料」是空心框，和「持平」的灰色不同。
- **每個數字有來源與時點。** 每個區塊標交易所與最後更新時間；動能指標標是哪一根 15 分鐘 K 棒。
- **單位要換成 USDT 並驗算量級。** 三間交易所的成交量單位不同，新增資料來源時用「量 × 價」核對。
- **推導的數字由程式算**，並有單元測試；不要在說明文字裡寫死數字。
- **解析失敗就丟錯**，不要回傳空陣列假裝沒資料。

## 已實測的事實（2026-11-15）

- OKX `tickers` 的 `volCcy24h` 對永續合約是「幣數」，不是 USDT（BTC、ETH、DOGE 以 `vol24h × ctVal` 驗過）。
  所以 OKX 的 24 小時成交額是近似值，畫面上以「≈」標示。K 線的 `volCcyQuote`（第 8 欄）才是 USDT。
- Pionex `tickers` 的 `amount` 是 USDT 成交額；K 線只有幣數，成交額以幣數 × 該棒代表價估算。
  Pionex 還有以 BTC、ETH 等計價的永續合約與美股代幣合約；只收 `_USDT_PERP` 結尾的。
- Pionex API 不送 CORS 標頭，瀏覽器不能直接呼叫，所以需要 `server/pionexProxy.ts` 這個轉接。
- **Pionex 會拒絕從 Cloudflare Workers 發出的請求**：線上 Worker 轉接 Pionex 一律得到 HTTP 429，
  而同一時間從一般主機直接呼叫是 200。回應裡 Pionex 自己的限流額度是滿的（`x-ratelimit-tokens: 30`），
  加不加 User-Agent 都一樣，所以不是真的超量，而是 Workers 的出口被擋。Pionex 轉接必須放在非 Cloudflare 的主機。
  Pionex 區塊因此先關閉。
- 部署環境的金鑰代理會覆寫 Authorization 標頭，Workers／Pages 的靜態檔上傳（用臨時憑證）會 401。
  所以網站檔案是內嵌進 Worker 腳本一次上傳的（`scripts/gen-assets.mjs`），不用 wrangler 的 `assets` 設定。
- OKX 的行情端點（`market/*`、`public/*`）與 CoinGecko 允許瀏覽器跨網域呼叫；
  **OKX 的統計端點（`rubik/stat/*`）不送 CORS 標頭**，所以 OI 歷史與主動買賣量要經 Worker 轉接。
  OKX 不像 Pionex 會擋 Cloudflare Workers，線上一次抓 50 檔沒有遇到限流。
- OKX `rubik/stat/taker-volume-contract`（`unit=2`）每列是 `[ts, 賣, 買]`，單位 USDT。欄位順序是實證的：
  BTC、SOL 各 99 根 15 分鐘 K 棒，(第 3 欄 − 第 2 欄) 與該棒漲跌的相關係數是 +0.61 與 +0.62；買＋賣等於 K 線的 USDT 成交額。
- OKX `rubik/stat/contracts/open-interest-history` 每列是 `[ts, 張數, 幣數, 美元值]`，`ts` 是 15 分鐘區間的開始，
  數值是該區間結束時的未平倉量（進行中的那一列會重複前一列的值）。解析時改標成區間結束時間，並丟掉進行中的那一列。
  新的一列會晚幾分鐘才出現。
- 幣安的 OI 用 `/futures/data/openInterestHist`（`sumOpenInterest`，幣數），主動買入量取自 K 線第 11 欄（taker buy quote volume）。
  開發環境測不到這幾項；使用者 2026-11-15 回報線上網站幣安區塊的 RVOL、OI、買賣比三欄都有數字，
  所以 `/futures/data/*` 可以從瀏覽器直接呼叫。數值本身是否正確沒有獨立驗算過。
- **幣安無法在開發環境實測**：開發用的雲端主機被幣安地區限制擋下（HTTP 451），解析程式與測試資料是照官方文件的欄位寫的。
  使用者 2026-11-15 回報線上網站的幣安區塊在自己的裝置上正常更新。動到幣安的程式時，仍要請使用者在自己的裝置上確認。
- 開發環境的代理不支援 WebSocket，所以第一版用輪詢。改 WebSocket 要在使用者裝置上驗證。

## 回測（第二階段，進行中）

事前登記與結果都在 `backtest/README.md`。使用者 2026-11-15 的決定：策略是動能、多空都測、
主要判定持有 1 小時、分兩段（15 天測四個訊號一起，12 個月只測漲跌＋RVOL）、並開始每天存檔 OI 與買賣量。
登記的訊號門檻與判定標準不可事後修改；要改就在該文件新增一節說明。

做回測時遵守：

- 跑之前先寫下假設、預期方向與判定標準；跑完只填結果。
- 樣本內、樣本外分開；調過參數的那段資料不算驗證。
- 交易筆數少於 30 筆標「無統計意義」。
- 不挑回測結果最好的那組參數當結論。
- 手續費與資金費率要算進去。

## 指令

- `npm run dev` 開發伺服器（Pionex 經 Vite 代理）
- `npm test` 單元測試
- `npm run build` 建置到 `dist/`、產生 `worker/assets.generated.ts`、型別檢查
- `npm run deploy` 建置並部署到 Cloudflare Workers（需要 `CLOUDFLARE_API_TOKEN` 與 `CLOUDFLARE_ACCOUNT_ID`）

線上網址：https://perp-heat.crypto-perp-heat.workers.dev

改完資料解析或熱度計算，要跑測試並用真實行情看過畫面才算完成。

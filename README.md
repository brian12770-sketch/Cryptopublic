# 永續合約熱度看板

幣安、OKX 兩間交易所 USDT 永續合約的報價、成交額熱力圖與量能異常，加上 CoinGecko 熱搜。
只讀公開行情，不連任何帳戶。

## 看得到什麼

- **熱力圖**：每間交易所成交額前 50 名。方塊越大成交額越高（開根號比例），顏色有四種模式：
  - RVOL：最近一根 15 分鐘 K 棒的成交額是平常的幾倍。
  - OI：未平倉量在這根 K 棒期間增加（藍）或減少（橘）。
  - 買賣比：主動買入 ÷ 主動賣出，大於 1 代表買方較積極。
  - 漲跌：24 小時漲跌，可切換綠漲紅跌或紅漲綠跌。
- **排行表**：15 分鐘漲跌、RVOL、OI 變化、買賣比、價格、24 小時漲跌、成交額。點欄位標題排序，再點一次反向。
- **熱搜**：CoinGecko 過去 24 小時搜尋最多的幣，並對照它在各交易所的 RVOL。
- **連線狀態**：每個區塊標示最後更新時間；連線中斷會明確顯示資料停在何時。

價格與成交額每 5 秒重抓一次，不是逐筆即時；15m、RVOL、OI、買賣比每 15 分鐘隨 K 棒收盤更新。下單前請以交易所畫面為準。

### 指標定義

四個指標都描述同一根「最近收盤的 15 分鐘 K 棒」。

| 指標 | 算法 |
|---|---|
| 15m | 該 K 棒開盤到收盤的漲跌 |
| RVOL | 該 K 棒成交額 ÷ 前 3 天所有 15 分鐘 K 棒成交額的中位數 |
| OI 變化 | 未平倉量（幣數）在該 K 棒期間的變化；點選合約可看近 1 小時的變化 |
| 買賣比 | 該 K 棒內主動買入成交額 ÷ 主動賣出成交額 |

## 本機執行

```bash
npm install
```

```bash
npm run dev
```

```bash
npm test
```

## 部署（Cloudflare Workers）

線上網址：https://perp-heat.crypto-perp-heat.workers.dev

整個網站是一支 Cloudflare Worker：`npm run build` 會把 `dist/` 的檔案內嵌進 Worker 腳本，由 `worker/index.ts` 回應。
Worker 另外轉接 OKX 的兩項統計（未平倉量歷史、主動買賣量），因為 OKX 不允許瀏覽器直接呼叫它們；轉接只放行這兩項的查詢。
設定在 `wrangler.jsonc`。

需要一把 Cloudflare API 金鑰，權限為帳號層級的 Workers Scripts 編輯，放在環境變數，不要寫進 repo：

```bash
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... npm run deploy
```

### Pionex 區塊目前關閉

Pionex 的 API 不允許瀏覽器直接呼叫，需要一段伺服器端轉接；而 Pionex 又拒絕從 Cloudflare Workers 發出的請求（一律回 HTTP 429）。
所以 Pionex 區塊先關閉，等轉接放到 Cloudflare 以外的主機再開回來。程式都還在：
`src/exchanges/pionex.ts`（解析）與 `server/pionexProxy.ts`（轉接，只放行行情查詢）。

## 資料來源

| 區塊 | 來源 | 成交額 |
|---|---|---|
| 幣安 | `fapi.binance.com` 公開行情、K 線、未平倉量歷史 | 交易所提供的 USDT 成交額 |
| OKX | `www.okx.com` 公開行情、K 線；未平倉量歷史與主動買賣量經 Worker 轉接 | 幣數 × 24 小時代表價，近似值 |
| 熱搜 | CoinGecko `search/trending` | — |

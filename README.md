# 永續合約熱度看板

幣安、OKX、Pionex 三間交易所 USDT 永續合約的報價、成交額熱力圖與量能異常，加上 CoinGecko 熱搜。
只讀公開行情，不連任何帳戶。

## 看得到什麼

- **熱力圖**：每間交易所成交額前 50 名。方塊越大成交額越高（開根號比例）。
  - 量能異常：顏色越深（深色模式越亮），代表最近一小時的成交額是平常的越多倍。
  - 漲跌幅：24 小時漲跌，可切換綠漲紅跌或紅漲綠跌。
- **排行表**：價格、24 小時漲跌、成交額、量能倍數，點欄位標題可排序。
- **熱搜**：CoinGecko 過去 24 小時搜尋最多的幣，並對照它在三間交易所的量能倍數。
- **連線狀態**：每個區塊標示最後更新時間；連線中斷會明確顯示資料停在何時。

行情每 5 秒重抓一次，不是逐筆即時。下單前請以交易所畫面為準。

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

Pionex 的 API 不允許瀏覽器直接呼叫，所以網站需要一小段伺服器端轉接。
這個 repo 用 Cloudflare Workers：`dist/` 裡的靜態檔由平台直接提供，`worker/index.ts` 只處理 `/api/pionex/*`。
設定在 `wrangler.jsonc`。

需要一把 Cloudflare API 金鑰，權限為帳號層級的 Workers Scripts 編輯，放在環境變數，不要寫進 repo：

```bash
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... npm run deploy
```

部署完成後打開網址，確認三個區塊都顯示「更新中」。

## 資料來源

| 區塊 | 來源 | 成交額 |
|---|---|---|
| 幣安 | `fapi.binance.com` 公開行情 | 交易所提供的 USDT 成交額 |
| OKX | `www.okx.com` 公開行情 | 幣數 × 24 小時代表價，近似值 |
| Pionex | `api.pionex.com` 公開行情，經 Worker 同源轉接 | 交易所提供的 USDT 成交額 |
| 熱搜 | CoinGecko `search/trending` | — |

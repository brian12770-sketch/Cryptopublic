# 追蹤

每個 `.json` 檔是一組追蹤條件。最簡單的建立方式是在網站的「篩選」頁設好條件後，按「在 GitHub 建立」或「複製設定」。

- **開始時間就是檔案最後一次提交的時間**，之後才開盤的 15 分鐘 K 棒才會被計入。
- **提交之後不要修改**：修改會讓追蹤從修改的時間重新開始計算。要換條件，請另外建一個新檔。
- 每天由 `.github/workflows/archive-okx.yml` 用前一天的 OKX 存檔資料更新，結果寫在 `data` 分支的 `tracking/results.json`。
  排定在 01:20 UTC（台北 09:20），但 GitHub 的排程常延遲：2026-11-16 那次晚了約 6.5 小時才執行。

格式：

```json
{
  "name": "強勢放量做多",
  "side": "long",
  "holdBars": 4,
  "feePct": 0.1,
  "conditions": {
    "useRet": true, "retMin": 0.5,
    "useRvol": true, "rvolMin": 2,
    "useTaker": false, "takerMin": 1.25,
    "useOi": false, "oiMin": 0.3,
    "useRs": true, "rsHorizon": "4h", "rsMin": 1,
    "useBreakout": false, "breakoutState": "fresh", "rangeBars": 20, "extendAtr": 1.5
  }
}
```

- `side`：`long`、`short` 或 `both`。
- `holdBars`：持有幾根 15 分鐘 K 棒，可用 1、2、4、8、16。
- `feePct`：來回手續費，百分比。
- `breakoutState`：`near`、`fresh`、`holding`、`extended` 之一（接近突破、剛突破、突破後整理、已延伸），定義見 `src/lib/breakout.ts`。
- 條件的意義與網站「篩選」頁相同，判斷規則在 `backtest/engine.ts` 的 `fires`。

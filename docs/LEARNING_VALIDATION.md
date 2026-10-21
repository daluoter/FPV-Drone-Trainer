# 第一批新手學習功能驗證

日期：2026-10-21。分支：`feat/beginner-flight-school`。本紀錄適用於第一批工作區、啟動契約、起飛與同步示範功能；不表示整個 v0.2 已完成。

## 已完成的軟體範圍

- 明確的 `COUNTDOWN → WAITING_FOR_ARM → ACTIVE`：首個有效已解鎖樣本建立計時起點，等待不消耗挑戰時間。
- UI 與 runtime 同時阻擋倒數解鎖；輸入來源與調參在進行中的課程鎖定，解除限制後不自動解鎖。
- 待解鎖期間按鍵盤 X 或 runtime 重設，清除待開始課程，不等待舊時間戳追上。
- 繁中課程工作區使用同一飛行 canvas／runtime，提供新手 preset、即時提示、三項重點指標及原有四課。
- L01 起飛：從起飛點受控離地，達相對目標高度並連續穩住；琥珀目標環與判定高度一致。
- 四軸／起飛示範由實際固定步長模擬產生，姿態、搖桿與字幕共用播放時間；不餵入評分或進度。
- 新成績按規則／物理版本、完整設定、preset、輸入與模式隔離；原有 v1 紀錄不被覆蓋。
- 保存失敗可見；設定改變後，結果與最佳成績仍顯示同一完成條件。
- PR CI 與正式路徑 Python Playwright smoke 已加入儲存庫；正式部署仍維持手動。

## 已執行檢查

| 檢查 | 結果與證據 |
| --- | --- |
| `npm test -- --maxWorkers=2` | PASS：37 個檔案、194 項測試。涵蓋現有四課、起飛正反例、等待／倒數鎖、context、保存失敗、結果條件一致性與示範。 |
| `npm run lint` | PASS，零警告規則。 |
| `npm run build -- --base=/FPV-Drone-Trainer/` | PASS，包含 TypeScript。Vite 仍有大於 500 kB 的 entry chunk 提示；最新約 945.44 kB／gzip 263.23 kB。 |
| `python scripts/browser_smoke.py --port 5181 --chromium-executable /usr/bin/chromium --screenshot` | PASS：Chromium 154，8 項功能檢查，沒有 page／console／資源錯誤。 |
| YAML／差異檢查 | CI workflow 使用官方 Actions，版本依可信來源固定；差異空白檢查通過。 |

瀏覽器實際驗證：

1. 正式 `/FPV-Drone-Trainer/` HTML、JavaScript／CSS 路徑。
2. 有效 WebGL2 drawing buffer。
3. 1280 × 720 下，開始課程與飛行控制在可視範圍。
4. 鍵盤明確 Arm／Disarm。
5. L01 倒數鎖、等待不評分、等待期間 X 重設、重新開始與停止。
6. 起飛示範暫停、seek、變速、同步字幕、錄製搖桿、播放退出及進度隔離。
7. FPV／Chase／Free 鏡頭切換。
8. Logo 重載後維持專案子路徑。

本次成功瀏覽器產物在執行機的 `/tmp/fpv-browser-smoke/run-o4dkyy3r/`，包含 report、console 及 workspace 截圖。CI 失敗時會保留 screenshot／trace／logs；本地暫存產物不視為永久發布紀錄。

初次人工截圖檢查發現舊樣式留下過大空白，以及課程卡片文字對比不足；已調整，並加入主要控制的 viewport 檢查。後續一次 viewport 檢查抓到開始按鈕低於畫面，將課程操作移至選課後方，再建置重跑後通過。失敗檢查沒有被當作通過。

## 尚未執行及下一個驗收點

- **實體遙控器／真人試學：未執行。** 需要使用者提供目標設備及試學者，驗證校正、方向、中心、斷線、手感、提示理解及是否能完成起飛。
- **示範飛手審核：未執行。** 現在是明示的模擬示範，不能宣稱真人可飛或教學門檻已校準。
- **遠端 GitHub CI、UAT、正式發布：本批未執行。** 本機已跑相應檢查；目前環境規則仍未允許 GitHub API，不能據此宣稱已建立 PR 或遠端 CI 已通過。UAT 的實際平台／origin 尚待選定。
- 無限時引導練習、完整 L00 互動課、L03 降落、L04 直線、全螢幕、資料匯出／匯入與回放持久化仍在清單中。
- 長時間效能、真實 GPU／瀏覽器變化與 20–30 分鐘循環壓力測試仍待驗收。Headless 軟體渲染的 FPS 不代表使用者設備的效能。

依規劃，接下來先做第一輪觀察性試學，記錄設定、卡住步驟、首次起飛時間、對提示的理解與重試後改善，再調整第一批門檻並擴充後續課程。

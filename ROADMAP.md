# Kế hoạch Khắc phục Hạn chế & Lộ trình Phát triển (`@1penny/*`)

Tài liệu này định nghĩa lộ trình kỹ thuật nhằm giải quyết triệt để các hạn chế kiến trúc hiện có của thư viện biểu đồ `@1penny/*` trước khi tích hợp vào ứng dụng giao dịch chính ở giai đoạn sau.

---

## Tổng quan các hạn chế hiện tại & Mục tiêu giải quyết

| # | Hạn chế hiện tại | Hệ quả thực tế | Giải pháp mục tiêu |
| :--- | :--- | :--- | :--- |
| **1** | **Thiếu `OkxAdapter` & chuẩn kết nối Perpetual Swap** | Chỉ có sẵn adapter Spot cơ bản (Binance, Bybit, Coinbase, Kraken, Upbit); chưa xử lý đặc thù phân trang `after`/`before` và độ trễ chốt nến đầu phút của OKX V5. | Xây dựng `OkxAdapter` (Spot + USDT-SWAP) và `PennyBackendFeed` chuẩn hóa phân trang cursor + đồng bộ WebSocket chống rớt nến `confirmed`. |
| **2** | **Engine khớp lệnh (`PaperExecutionAdapter`) & `Backtester` quá đơn giản** | Khớp lệnh kiểu hedging/spot đơn giản bằng `number` dấu phẩy động; không có Netting 1 chiều, không có Cross/Isolated Margin Tiers, không tính thanh lý, không tính Funding 8h, không xét worst-case đường đi giá nội nến M1. | Nâng cấp lên `PerpetualExecutionEngine` đồng nhất quy tắc phái sinh: Netting, Margin Tiers (`IMR`/`MMR`/`maxLever`), chặn rút âm Isolated Margin, duyệt worst-case OHLC intrabar + gắn cờ `ambiguous`, tính phí Funding và đối soát sổ cái độc lập. |
| **3** | **Monolith lớn ở tầng điều phối (`Chart.ts` ~295 KB, `ChartWidget.ts` ~180 KB, `DrawingManager.ts` ~82 KB)** | Khó bảo trì, khó viết test cô lập cho từng mảng, và tốn dung lượng bundle nếu ứng dụng đích chỉ cần tầng vẽ Canvas/WebGL kèm kéo thả lệnh mà tự quản lý Toolbar/Modal riêng. | Tách nhỏ nội bộ `Chart.ts` thành các controller chuyên biệt; cung cấp bộ **Headless Trading Hooks** cho `@1penny/react` để ghép mượt với UI component chuẩn bên ngoài mà không phải tải toàn bộ DOM của `ChartWidget`. |
| **4** | **Lưu trữ Layout & Drawings nguyên khối (`saveState`)** | Xuất một cục JSON duy nhất vào `localStorage`; khi người dùng vẽ nhiều (> 64 KiB) sẽ vượt trần `fetch keepalive` của trình duyệt và khó merge khi mở nhiều tab/thiết bị. | Tách trạng thái thành 2 tầng (Chart Config nhẹ vs Drawings theo từng mã) kèm cơ chế Delta Patch, kiểm tra quota dung lượng và 3-way merge theo `ETag`. |

---

## Chi tiết Kế hoạch Triển khai theo từng Phase

### Phase 0 — Độc lập hóa & Chuẩn hóa Monorepo `@1penny/*` *(Hoàn thành ở đợt khởi tạo)*
- [x] Tách hoàn toàn mã nguồn sang namespace `@1penny/*` (`commons`, `core`, `chart`, `react`, `vue`, `svelte`, `analytics`, `mcp`).
- [x] Chuẩn hóa hệ thống token CSS `--1p-*`, DOM `data-pcw-*` / `.pcw-*`, storage key `1p:*` và URL share `#1p=`.
- [x] Loại bỏ toàn bộ website marketing (`demo`), bộ nhận diện thương hiệu gốc, lịch sử phát hành cũ và toàn bộ liên kết ngoài không cần thiết.
- [x] Đảm bảo 100% gói build sạch, pass `tsc --noEmit`, unit tests, và đồng bộ danh mục `@1penny/mcp`.

---

### Phase 1 — Xây dựng `OkxAdapter` & Chuẩn hóa Tầng Đồng bộ Dữ liệu (`@1penny/core`) *(Đã hoàn thành)*

- [x] **`OkxAdapter` hỗ trợ đầy đủ Spot & Perpetual (`USDT-SWAP`)**:
  - Tự động chọn `/api/v5/market/candles` cho dữ liệu gần (< 1.400 nến) và `/api/v5/market/history-candles` khi `HistoryPager` phân trang lùi sâu về quá khứ; tự gom nhiều trang khi `limit > 300`.
  - Xử lý race condition đầu phút trên WebSocket (`confirm = "0"` của `T+1m` tới trước `confirm = "1"` của `T`) thông qua rollover chốt tạm trong `TickAggregator` + `barCorrection` cập nhật cả nến đóng lẫn `previousClose`.
  - Cô lập lỗi theo từng mã (`symbol`) khi subscribe quotes nhiều luồng.
- [x] **`PennyBackendFeed` (Adapter kết nối API nội bộ)**:
  - Cài đặt chuẩn `DataFeed` (`getBars`, `subscribeBars`, `subscribeQuotes`, `resolveSymbol`) dùng chung 1 WebSocket duy nhất cho nhiều biểu đồ, tính đúng delta volume nội phút cho các khung lớn (`H1`/`D1`...) không bị lệch khi `getBars` nạp lại lịch sử giữa phút, và chống ghi đè giá live bởi gói HTTP `/api/tickers` đến trễ.

---

### Phase 2 — Chuẩn hóa Engine Phái sinh & Backtest (`@1penny/analytics` + `@1penny/core/trading`) *(Đã hoàn thành)*

- [x] **Số học chính xác & Netting Position**:
  - Làm tròn chuẩn xác `1e-8` chống trôi dấu phẩy động; hỗ trợ cả `'hedging'` và `'netting'` trong `PaperExecutionAdapter` và `PerpetualExecutionEngine` (bình quân giá vốn, giảm vị thế, đảo chiều 1 lệnh, gom nhóm `episodes` flat-to-flat).
- [x] **Quản trị Rủi ro Cross / Isolated Margin Tiers**:
  - Hỗ trợ bậc thang ký quỹ (`minSz`, `maxSz`, `mmr`, `imr`, `maxLever`) và `ctVal`.
  - Chặn chặt chẽ rút âm Isolated Margin hoặc rút dưới `max(initialMargin, initialMargin - min(0, unrealizedPnl))`.
- [x] **Khớp lệnh Nội nến Worst-Case & Cờ `ambiguous`**:
  - Duyệt cả hai đường đi giá đơn điệu `[O,H,L,C]` và `[O,L,H,C]`, chọn nhánh bảo thủ nhất và gắn `ambiguous: true` khi SL/Liquidation và TP xung đột trong cùng cây nến; bổ sung `stepBar(bar)` cho `PaperExecutionAdapter`.
- [x] **Funding Rate, Đối soát Sổ cái & Đồng bộ Nến Khởi tạo**:
  - Tính phí Funding theo mốc thời gian, ghi nhận `isolatedDeficitCredit`, kiểm chứng độc lập bằng `verifyPerpetualLedger`, và đảm bảo đồng nhất 100% giữa `runPerpetualBacktest` và `PerpetualReplaySession` ngay từ cây nến `bars[0]`.

---

### Phase 3 — Tách nhỏ Kiến trúc Monolith & Tối ưu Gói `@1penny/react` *(Đã hoàn thành)*

- [x] **Phân rã nội bộ `Chart.ts` và `DrawingManager.ts`** *(giữ nguyên 100% Public API)*:
  - Tách các mô-đun điều phối độc lập dưới `packages/library/src/controllers/` (`TradingExecutionController` cho cầu nối `TradingManager` ↔ `ExecutionAdapter`, `DataExportController` cho xuất dữ liệu CSV/JSON) song song với các coordinator sẵn có (`DataManager`, `HistoryPager`, `SeriesStore`, `replay/`, `state/`, `trading/`).
  - Tách `drawingClipboard` (`DrawingClipboard`, `sharedDrawingClipboard`) và `drawingGroups` (`listDrawingGroups`, `reorderDrawingList`, `mutateDrawingGroup`, `createDrawingGroup`) khỏi `DrawingManager.ts` cùng các mô-đun `drawingState`, `drawingHistory`, `magnetSnap`, `DrawingSelection`, `DrawingDrag`.
- [x] **Nâng cấp `@1penny/react` (`<PennyChart />`) cho Kiến trúc Host-Controlled UI**:
  - Bổ sung đầy đủ reactive props & callbacks đã unwrap payload cho giao dịch, replay và công cụ vẽ (`orders`, `positions`, `executionAdapter`, `executionConfig`, `activeDrawingTool`, `magnetMode`, `timeZone`, `onBarClick`, `onOrderPlace`, `onOrderModify`, `onOrderCancel`, `onPositionModify`, `onPositionClose`, `onPositionReverse`, `onExecutionFill`, `onDrawingCreate`, `onDrawingUpdate`, `onDrawingRemove`, `onDrawingToolChange`, `onReplayStep`).
  - Cho phép ứng dụng React dùng hệ thống control riêng (như HeroUI + Tabler Icons) điều khiển trực tiếp lõi `Chart` nhẹ mà không phải tải khung UI DOM của `ChartWidget`.

---

### Phase 4 — Chuẩn hóa Lưu trữ Layout / Drawings Phân mảnh & Đa Tab

1. **API Xuất/Nhập Trạng thái Tách lớp**:
   - Bổ sung `chart.exportChartConfig()` / `chart.importChartConfig()` (chỉ gồm loại biểu đồ, theme, overrides, danh sách chỉ báo — dung lượng < 4 KB).
   - Bổ sung `chart.exportDrawings({ symbol })` / `chart.importDrawings(payload)` kèm theo dõi thay đổi tăng dần (`revision` + danh sách `upserted` / `deleted` drawing IDs).
2. **An toàn truyền tải Cloud Autosave**:
   - Cung cấp tiện ích kiểm tra kích thước byte trước khi serialize, giới hạn số lượng điểm vẽ tối đa (ví dụ cho công cụ vẽ tay freehand `brush`/`highlighter`) để không làm phình payload, và hỗ trợ cơ chế tự động bỏ cờ `keepalive` khi payload lớn hơn 60 KB.

---

### Phase 5 — Tích hợp vào Ứng dụng Giao dịch Chính *(Chưa thực hiện ở giai đoạn hiện tại)*

Sau khi hoàn thành và kiểm thử đầy đủ Phase 1 → Phase 4 trên kho `1penny`:
1. Liên kết gói `@1penny/chart` và `@1penny/react` vào frontend của ứng dụng chính.
2. Chuyển đổi component biểu đồ sang `<PennyChart />` kết nối với `PennyBackendFeed`, giữ toàn bộ thanh công cụ và hộp thoại bên ngoài tuân thủ nghiêm ngặt quy chuẩn UI của ứng dụng.
3. Chạy kiểm thử đối chiếu (parity test) giữa kết quả Replay/Backtest hiển thị trên biểu đồ mới và sổ cái phía server trước khi phát hành.

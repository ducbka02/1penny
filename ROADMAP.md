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

### Phase 2 — Chuẩn hóa Engine Phái sinh & Backtest (`@1penny/analytics` + `@1penny/core/trading`)

1. **Số học chính xác & Netting Position**:
   - Bổ sung module tính toán khối lượng/phí/PnL tránh sai số cộng dồn `float64` qua hàng triệu nến.
   - Chuyển `PaperExecutionAdapter` sang hỗ trợ cả 2 chế độ: `'hedging'` (mặc định cũ) và `'netting'` (chuẩn Perpetual Swap một chiều: gộp giá vốn bình quân khi bồi lệnh, chốt từng phần, đảo chiều vị thế trong 1 lệnh và gom nhóm `episodes` từ lúc mở tới lúc đóng hết vị thế).
2. **Quản trị Rủi ro Cross / Isolated Margin Tiers**:
   - Nhận cấu hình bậc thang ký quỹ (`tiers`: `minSz`, `maxSz`, `mmr`, `imr`, `maxLever`) và `ctVal` của hợp đồng.
   - Áp công thức kiểm tra ký quỹ chặt chẽ khi rút/nạp Isolated Margin:
     - Chỉ cho phép rút khi margin còn lại lớn hơn hoặc bằng `max(initial_margin, initial_margin - min(0, unrealized_pnl))`, tuyệt đối chặn trạng thái `margin <= 0` hoặc vượt trần đòn bẩy của tier.
3. **Khớp lệnh Nội nến Worst-Case & Cờ `ambiguous`**:
   - Trong `Backtester` và chế độ Replay theo bước nến, kiểm tra các đường đi giá đơn điệu hợp lệ trong cây nến (`Open → High → Low → Close` và `Open → Low → High → Close`).
   - Khi cả Stop-Loss / Liquidation và Take-Profit cùng có thể kích hoạt trong cùng một cây nến M1 mà không có dữ liệu tick nhỏ hơn, ưu tiên kịch bản bảo thủ (worst-case) và đánh dấu `ambiguous: true` trên bản ghi khớp lệnh.
4. **Funding Rate & Đồng bộ Nến Khởi tạo**:
   - Hỗ trợ truyền chuỗi sự kiện `fundingRates` vào `Backtester` và `ReplayController`.
   - Đồng bộ hóa bước khởi tạo chỉ báo tại cây nến `start` đầu tiên giữa chế độ chạy chiến lược tự động (Backtest) và chế độ tua từng bước (Strategy Replay) để kết quả khớp tuyệt đối 100%.

---

### Phase 3 — Tách nhỏ Kiến trúc Monolith & Tối ưu Gói `@1penny/react`

1. **Phân rã nội bộ `Chart.ts` và `DrawingManager.ts`** *(giữ nguyên 100% Public API)*:
   - Tách `Chart.ts` thành 4 mô-đun độc lập dưới `packages/library/src/controllers/`:
     - `SeriesLifecycleController`: quản lý `setData`, `appendBar`, `updateLastBar`, `updateBar`, `HistoryPager` và `StreamManager`.
     - `IndicatorCoordinator`: điều phối `IndicatorEngine`, `IndicatorWorkerPool` và các pane phụ.
     - `ReplayCoordinator`: điều phối `ReplayManager`, `ReplayStepLoader` và ẩn/hiện markers/trade zones theo thời gian replay.
     - `TradingOverlayController`: cầu nối giữa `TradingManager`, thao tác kéo thả đường giá trên canvas và `ExecutionAdapter`.
   - Tách `DrawingManager.ts` thành `DrawingStore` (dữ liệu & undo/redo), `DrawingHitTester` (bắt điểm & nam châm) và `DrawingClipboard` (copy/paste/group).
2. **Nâng cấp `@1penny/react` (`<PennyChart />`) cho Kiến trúc Host-Controlled UI**:
   - Bổ sung đầy đủ reactive props & callbacks cho giao dịch và công cụ vẽ (`orders`, `positions`, `activeDrawingTool`, `drawings`, `replayState`, `onOrderPlace`, `onOrderModify`, `onOrderCancel`, `onPositionModify`, `onPositionClose`, `onDrawingChange`).
   - Giúp ứng dụng React dùng hệ thống control riêng (như HeroUI + Tabler Icons) điều khiển trực tiếp lõi `Chart` nhẹ và mượt mà không cần nhúng khung UI DOM của `ChartWidget`.

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

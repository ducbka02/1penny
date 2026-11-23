# 1Penny Chart (`@1penny/chart`)

Thư viện biểu đồ tài chính và giao dịch hiệu năng cao cho trình duyệt, viết bằng TypeScript nghiêm ngặt, **zero runtime dependencies**, hỗ trợ kết xuất kép **Canvas 2D & WebGL 2**.

## Kiến trúc Monorepo

| Package | Vai trò |
| :--- | :--- |
| `@1penny/commons` | Kiểu dữ liệu cốt lõi (`OHLCBar`, `DataFeed`, `TimeFrame`), bảng màu, bộ icon vector nội bộ và quy tắc thị trường. |
| `@1penny/core` | Engine kết xuất Canvas 2D / WebGL 2, viewport, 134 chỉ báo kỹ thuật (+ Web Worker pool), 76 công cụ vẽ, gộp tick, quản lý stream và khớp lệnh trên biểu đồ. |
| `@1penny/chart` | Gói chính (`packages/library`): cung cấp `Chart` (headless) và `ChartWidget` / `ChartWidgetGrid` (giao diện giao dịch đầy đủ), 14 biểu đồ phân tích tài chính phụ trợ và 30 ngôn ngữ. |
| `@1penny/react` | Component `<PennyChart />` cho React 18/19. |
| `@1penny/vue` | Component `<PennyChart />` cho Vue 3. |
| `@1penny/svelte` | Component `<PennyChart />` cho Svelte 5. |
| `@1penny/analytics` | Bộ chạy Backtest cơ sở, tính toán chỉ số rủi ro (Sharpe, Sortino, Calmar, Max Drawdown) và mô phỏng Monte Carlo. |
| `@1penny/mcp` | MCP Server nội bộ hỗ trợ AI agent tra cứu danh mục chỉ báo, công cụ vẽ, style keys và kiểm tra cấu hình (`validate_options`). |

## Tính năng nổi bật

- **18 loại biểu đồ & 134 chỉ báo**: Candlestick, Hollow Candle, Heikin-Ashi, Renko, Kagi, Point & Figure, Line Break, Range Bars, Volume Profile, Market Profile (TPO), Depth Heatmap; hỗ trợ lồng chỉ báo trên chỉ báo (`indicatorSource`) và tính toán bất đồng bộ trên Web Worker.
- **76 công cụ vẽ & Cảnh báo**: Fibonacci, Pitchfork, Gann, Elliott Wave, Anchored VWAP, Risk/Reward, gắn cảnh báo trực tiếp trên đường kẻ, undo/redo, gom nhóm.
- **Chart Trading & Bar Replay**: Kéo thả trực tiếp Entry / Limit / Stop-Loss / Take-Profit ngay trên biểu đồ, tua lại lịch sử (`0.1x` – `50x`) kèm hoạt ảnh dựng nến từ khung thời gian nhỏ hơn (`ReplayStepLoader`).
- **Hiệu năng thực chứng**: Pan/zoom mượt 1.000.000 nến ở ~60 fps với WebGL 2; xử lý 30.000 trade/giây liên tục không rò rỉ bộ nhớ (xem [benchmarks/2026-11-03.md](https://github.com/ducbka02/1penny/blob/main/benchmarks/2026-11-03.md)).

## Khởi tạo nhanh

### 1. Dùng `ChartWidget` đầy đủ giao diện

```ts
import { ChartWidget } from '@1penny/chart/widget';
import { BinanceAdapter } from '@1penny/chart';

const widget = new ChartWidget(document.getElementById('chart')!, {
  symbol: 'BTCUSDT',
  timeframe: '5m',
  theme: 'dark',
  locale: 'vi',
  adapter: new BinanceAdapter(),
  trading: true,
});
```

### 2. Cắm nguồn dữ liệu riêng (`DataFeed`)

```ts
import { Chart, type DataFeed } from '@1penny/chart';

const feed: DataFeed = {
  name: '1penny-api',
  getBars: ({ symbol, timeframe, countBack, before, signal }) =>
    fetch(`/api/candles?symbol=${symbol}&tf=${timeframe}&limit=${countBack}&before=${before ?? ''}`, { signal })
      .then((r) => r.json()),
  subscribeBars: ({ symbol, timeframe }, subscriber) => {
    const ws = new WebSocket(`wss://example.com/ws/market?symbol=${symbol}&tf=${timeframe}`);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      subscriber.bar(msg.bar, msg.closed);
    };
    ws.onclose = () => subscriber.connection('disconnected');
    return () => ws.close();
  },
};

const chart = new Chart(document.getElementById('chart')!, { theme: 'dark' });
await chart.connect({ feed, symbol: 'BTC-USDT-SWAP', timeframe: '1m' });
```

### 3. Dùng với React (`@1penny/react`)

```tsx
import { PennyChart } from '@1penny/react';

export function MarketView() {
  return (
    <div style={{ width: '100%', height: 600 }}>
      <PennyChart symbol="BTCUSDT" timeframe="15m" theme="dark" indicators={['ema', 'rsi']} />
    </div>
  );
}
```

## Phát triển & Kiểm thử

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
pnpm docs:check
```

## Lộ trình khắc phục hạn chế & nâng cấp

Xem chi tiết kiến trúc và kế hoạch triển khai các giai đoạn tiếp theo tại [ROADMAP.md](https://github.com/ducbka02/1penny/blob/main/ROADMAP.md).

## Giấy phép

Phát hành theo giấy phép [MIT](https://github.com/ducbka02/1penny/blob/main/LICENSE).

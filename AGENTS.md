# 1Penny Repository Rules

- **Zero runtime dependencies** in `@1penny/commons`, `@1penny/core`, `@1penny/chart`, and `@1penny/analytics`.
- **CSS & DOM tokens**:
  - Widget CSS custom properties use `--1p-*`.
  - Widget DOM classes use `.pcw-*` and `data-pcw-*` (`el.dataset.pcw*`).
  - Core accessibility/icon classes use `.pc-icon`, `.pc-sr-only`, `.pc-sr-live`.
  - Browser storage keys use `1p:*` and share hashes use `#1p=`.
- **Verification before commit**:
  - `pnpm build`
  - `pnpm typecheck`
  - `pnpm test`
  - `pnpm docs:check` (run `pnpm docs:gen` after changing indicator definitions, style keys, or options interfaces)
  - `pnpm test:scripts`

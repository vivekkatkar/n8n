# worker

Background worker that consumes queued workflow executions, evaluates triggers using live market data, and executes exchange actions.

## Run

```bash
bun run start
```

## Environment

- `MONGODB_URI` optional if root/default env is configured
- `MONGODB_DB` optional
- `WORKER_POLL_INTERVAL_MS` optional, defaults to `3000`
- `TRADING_MODE` optional: `paper` (default) or `live`
- `CREDENTIAL_ENCRYPTION_KEY` must match backend for credential decryption

## Execution Behavior

- `timer` trigger waits actual configured seconds (capped to 10s per run for safety).
- `price-trigger` pulls live USD spot prices from CoinGecko.
- Action nodes use exchange-specific credential contracts from shared metadata.
- In `paper` mode, orders are validated and logged but not sent.
- In `live` mode, worker submits real market orders via exchange adapters.

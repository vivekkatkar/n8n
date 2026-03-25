# backend

Trading bot API server for auth, workflow storage and credentials.

## Run

```bash
bun install
bun run start
```

Server runs on `http://localhost:4000` by default.
Current project `.env` uses `PORT=4010`.

## Environment

- `MONGODB_URI` optional, defaults to `mongodb://127.0.0.1:27017`
- `MONGODB_DB` optional, defaults to `trading-bot`
- `JWT_SECRET` optional for local development, recommended in production
- `CREDENTIAL_ENCRYPTION_KEY` required in production and should match worker value

If SRV DNS is blocked in your network (`querySrv ECONNREFUSED`), use Atlas non-SRV format:

`mongodb://<user>:<password>@<host1>:27017,<host2>:27017,<host3>:27017/?ssl=true&replicaSet=<replicaSet>&authSource=admin&retryWrites=true&w=majority&appName=<app>`

## Auth

- `POST /signup`
	- body: `{ "username": "alice", "password": "secret" }`
	- response: `{ token, user }`
- `POST /signin`
	- body: `{ "username": "alice", "password": "secret" }`
	- response: `{ token, user }`

Use returned token in `Authorization: Bearer <token>` for protected routes.

- `GET /me` (protected)
	- response: `{ user }`

## Workflow

- `POST /workflow` (protected)
	- body: `{ name?, nodes, edges }`
	- validates node kinds and metadata aligned with frontend builder
- `PUT /workflow` (protected)
	- body: `{ workflowId, name?, nodes, edges }`
- `GET /workflow/:workflowId` (protected)
- `GET /workflow/executions/:workflowId` (protected)
- `GET /workflows` (protected)
	- returns all workflows for the signed-in user
- `POST /workflow/:workflowId/run` (protected)
	- creates a queued execution event consumed by worker
- `GET /executions/:executionId` (protected)
	- full execution logs/output for one execution

## Worker Integration

- Backend writes queued execution events into `WorkflowExecution` collection.
- Worker app (`apps/worker`) polls queued executions, runs trigger/action graph logic,
	and updates execution state (`running` -> `success`/`failed`) with logs.

## Credentials

- `POST /credentials` (protected)
	- body: `{ exchange, apiKey, apiSecret, passphrase?, label? }`
	- `exchange` must be one of: `hyperliquid`, `lighter`, `backpack`
	- required credential fields differ per exchange (returned by `GET /nodes`)
- `GET /credentials` (protected)
	- returns masked credentials only
- `DELETE /credentials/:credentialId` (protected)

## Metadata

- `GET /nodes`
	- returns `{ triggers, actions, assets }`
	- each `actions[]` entry includes:
		- `credentials.requiredFields`
		- `credentials.optionalFields`
		- `api.baseUrl`, `api.orderPath`, `api.docsUrl`
- `GET /health`
	- returns `{ ok: true }`

## Notes

- Storage is MongoDB-backed via the shared `db` package.
- Credential secrets are encrypted at rest via `CREDENTIAL_ENCRYPTION_KEY`.

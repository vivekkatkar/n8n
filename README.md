# Trading Bot Monorepo

This workspace contains:

- Frontend: React + Vite workflow builder
- Backend: Express API for auth, workflows, and credentials
- Database: MongoDB (Atlas or local) via Mongoose models in `packages/db`

## 1. Install Dependencies

```bash
bun install
```

## 2. Configure Environment

Create `apps/backend/.env`:

```env
MONGODB_URI=mongodb+srv://<username>:<password>@<cluster>/?appName=<app>
MONGODB_DB=trading-bot
JWT_SECRET=change-me
CREDENTIAL_ENCRYPTION_KEY=replace-with-long-random-secret
PORT=4000
```

Create `apps/frontend/.env` (optional; defaults to `http://localhost:4000`):

```env
VITE_API_URL=http://localhost:4000
```

## 3. Atlas Access (Required for Atlas)

If you use MongoDB Atlas, whitelist your IP in Atlas:

- Atlas Dashboard -> Network Access -> Add IP Address
- Add your current IP or `0.0.0.0/0` for development only

Without this, backend startup fails with `MongooseServerSelectionError`.

## 4. Run Backend

```bash
cd apps/backend
bun run start
```

## 5. Run Frontend

```bash
cd apps/frontend
bun run dev
```

Frontend URL: `http://localhost:5173`
Backend URL: `http://localhost:4010` (current local `.env`) or configured `PORT`

## 6. Run Worker

```bash
cd apps/worker
bun run start
```

Worker consumes queued executions from MongoDB and performs trigger/action execution.

Recommended `apps/worker/.env`:

```env
MONGODB_URI=mongodb+srv://<username>:<password>@<cluster>/?appName=<app>
MONGODB_DB=trading-bot
WORKER_POLL_INTERVAL_MS=3000
TRADING_MODE=paper
CREDENTIAL_ENCRYPTION_KEY=replace-with-same-value-as-backend
```

## 7. End-to-End Flow

1. Open frontend and sign up/sign in.
2. Add exchange credentials in the left control panel.
3. Build trigger/action workflow graph.
4. Save workflow to backend -> persisted in MongoDB.
5. Load previously saved workflows from backend.
6. Run workflow from dashboard; worker consumes queued execution and updates logs/status.

## Exchange Credentials and Real Execution

- Each action requires exchange-specific credentials (exposed by `GET /nodes`).
- Backend validates that action node credential exchange matches action type.
- Worker can run in:
	- `paper`: validate + log orders without sending to exchange
	- `live`: submit market orders via exchange adapters
- Keep `TRADING_MODE=paper` until you verify credentials and risk controls.

## API Summary

- `POST /signup`
- `POST /signin`
- `GET /me`
- `GET /nodes`
- `POST /workflow`
- `PUT /workflow`
- `GET /workflow/:workflowId`
- `GET /workflows`
- `GET /workflow/executions/:workflowId`
- `POST /workflow/:workflowId/run`
- `GET /executions/:executionId`
- `POST /credentials`
- `GET /credentials`
- `DELETE /credentials/:credentialId`
- `GET /health`

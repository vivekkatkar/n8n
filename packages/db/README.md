# db

Shared MongoDB models and connection helper used by backend.

## Install

```bash
bun install
```

## Environment

- `MONGODB_URI` required
- `MONGODB_DB` optional

## Exports

- `connectToDatabase(connectionString?)`
- `encryptSecret(value)`
- `decryptSecret(value)`
- `UserModel`
- `WorkflowModel`
- `CredentialModel`
- `WorkflowExecutionModel`

## Example

```bash
bun x node -e "import('db/client').then(async (m) => { await m.connectToDatabase(process.env.MONGODB_URI); console.log('connected'); process.exit(0); })"
```

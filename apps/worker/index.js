import {
  decryptSecret,
  connectToDatabase,
  CredentialModel,
  WorkflowExecutionModel,
  WorkflowModel,
} from "db/client";
import ccxt from "ccxt";
import { ACTION_INTEGRATIONS } from "commons/types";

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 3000);
const TRADING_MODE = (process.env.TRADING_MODE ?? "paper").toLowerCase();

const COINGECKO_IDS = {
  SOL: "solana",
  ETH: "ethereum",
  BTC: "bitcoin",
};

const EXCHANGE_CLIENT_IDS = {
  hyperliquid: "hyperliquid",
  lighter: "lighter",
  backpack: "backpack",
};

const ACTION_MAP = new Map(ACTION_INTEGRATIONS.map((integration) => [integration.id, integration]));

let isWorking = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createNodeMap(nodes) {
  const map = new Map();
  for (const node of nodes) {
    map.set(node.id, node);
  }
  return map;
}

function createOutgoingEdgeMap(edges) {
  const map = new Map();
  for (const edge of edges) {
    if (!map.has(edge.source)) {
      map.set(edge.source, []);
    }
    map.get(edge.source).push(edge.target);
  }
  return map;
}

async function evaluateTrigger(node, logs) {
  if (node.type === "timer") {
    const requestedSeconds = Number(node.data?.metadata?.time ?? 1);
    const waitSeconds = Math.max(1, Math.min(requestedSeconds, 10));
    logs.push(`Timer trigger waiting for ${waitSeconds}s`);
    await sleep(waitSeconds * 1000);
    logs.push("Timer trigger fired");
    return true;
  }

  if (node.type === "price-trigger") {
    const targetPrice = Number(node.data?.metadata?.price ?? 0);
    const asset = String(node.data?.metadata?.asset ?? "").toUpperCase();
    const currentPrice = await fetchSpotPriceUsd(asset);

    logs.push(`Price trigger check: asset=${asset}, current=${currentPrice}, target=${targetPrice}`);

    if (targetPrice <= 0) {
      logs.push("Invalid target price, trigger skipped");
      return false;
    }

    const fired = currentPrice <= targetPrice;
    logs.push(fired ? "Price trigger fired" : "Price trigger did not fire");
    return fired;
  }

  logs.push(`Unsupported trigger type ${node.type}`);
  return false;
}

async function fetchSpotPriceUsd(asset) {
  const coinId = COINGECKO_IDS[asset];
  if (!coinId) {
    throw new Error(`No market data mapping found for asset ${asset}`);
  }

  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to fetch spot price for ${asset}`);
  }

  const payload = await response.json();
  const price = Number(payload?.[coinId]?.usd);

  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`Invalid market price for ${asset}`);
  }

  return price;
}

function resolveRequiredCredentialFields(exchange) {
  const action = ACTION_MAP.get(exchange);
  if (!action) {
    return ["apiKey", "apiSecret"];
  }

  return action.credentials?.requiredFields ?? ["apiKey", "apiSecret"];
}

function assertCredentialFields(exchange, secretBag) {
  const requiredFields = resolveRequiredCredentialFields(exchange);
  const missing = requiredFields.filter((field) => !secretBag[field]);

  if (missing.length > 0) {
    throw new Error(`Credential for ${exchange} missing fields: ${missing.join(", ")}`);
  }
}

function buildCcxtClient(exchange, secretBag) {
  const clientId = EXCHANGE_CLIENT_IDS[exchange];
  if (!clientId) {
    throw new Error(`Unsupported exchange adapter: ${exchange}`);
  }

  const ExchangeClass = ccxt[clientId];
  if (!ExchangeClass) {
    throw new Error(`Exchange ${exchange} is not supported by current ccxt build`);
  }

  return new ExchangeClass({
    apiKey: secretBag.apiKey,
    secret: secretBag.apiSecret,
    password: secretBag.passphrase || undefined,
    enableRateLimit: true,
  });
}

async function createExchangeOrder({ exchange, metadata, secretBag, logs }) {
  const symbol = `${String(metadata.symbol ?? "").toUpperCase()}/USDT`;
  const side = metadata.type === "short" ? "sell" : "buy";
  const amount = Number(metadata.qty ?? 0);

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`Invalid order qty for ${exchange}`);
  }

  if (TRADING_MODE !== "live") {
    logs.push(`PAPER mode: ${exchange} ${side.toUpperCase()} ${amount} ${symbol}`);
    return {
      mode: "paper",
      exchange,
      symbol,
      side,
      amount,
      status: "accepted",
    };
  }

  const client = buildCcxtClient(exchange, secretBag);
  const order = await client.createMarketOrder(symbol, side, amount);
  return {
    mode: "live",
    exchange,
    orderId: order?.id ?? null,
    symbol: order?.symbol ?? symbol,
    side: order?.side ?? side,
    amount: order?.amount ?? amount,
    status: order?.status ?? "submitted",
    raw: order,
  };
}

async function executeAction(node, workflow, logs) {
  const metadata = node.data?.metadata ?? {};
  const credentialId = metadata.credentialId;

  if (!credentialId) {
    throw new Error(`Missing credential for action node ${node.id}`);
  }

  const credential = await CredentialModel.findOne({
    _id: credentialId,
    userId: workflow.userId,
  });
  if (!credential) {
    throw new Error(`Credential ${credentialId} not found for action node ${node.id} and user`);
  }

  if (credential.exchange !== node.type) {
    throw new Error(
      `Credential exchange mismatch on node ${node.id}: node=${node.type}, credential=${credential.exchange}`,
    );
  }

  const secretBag = {
    apiKey: decryptSecret(credential.apiKey),
    apiSecret: decryptSecret(credential.apiSecret),
    passphrase: credential.passphrase ? decryptSecret(credential.passphrase) : "",
  };

  assertCredentialFields(node.type, secretBag);

  logs.push(
    `Executing action ${node.type}: ${metadata.type?.toUpperCase?.() ?? "UNKNOWN"} ${metadata.qty} ${metadata.symbol}`,
  );

  const orderResult = await createExchangeOrder({
    exchange: node.type,
    metadata,
    secretBag,
    logs,
  });

  logs.push(`Action ${node.type} completed (${orderResult.mode})`);
  return orderResult;
}

async function runExecution(execution) {
  const workflow = await WorkflowModel.findById(execution.workflowId);

  if (!workflow) {
    execution.status = "failed";
    execution.error = "workflow not found";
    execution.finishedAt = new Date();
    execution.logs.push("Workflow not found");
    await execution.save();
    return;
  }

  const logs = [...execution.logs, `Worker picked execution at ${new Date().toISOString()}`];
  execution.status = "running";
  execution.startedAt = new Date();
  execution.logs = logs;
  await execution.save();

  try {
    const nodes = workflow.nodes ?? [];
    const edges = workflow.edges ?? [];
    const nodeMap = createNodeMap(nodes);
    const outgoingMap = createOutgoingEdgeMap(edges);

    const triggerNodes = nodes.filter((node) => node?.data?.kind === "trigger");
    if (triggerNodes.length === 0) {
      throw new Error("No trigger nodes available");
    }

    const actionResults = [];

    for (const triggerNode of triggerNodes) {
      const fired = await evaluateTrigger(triggerNode, logs);
      if (!fired) {
        continue;
      }

      const queue = [...(outgoingMap.get(triggerNode.id) ?? [])];
      const visited = new Set();

      while (queue.length > 0) {
        const nodeId = queue.shift();
        if (!nodeId || visited.has(nodeId)) {
          continue;
        }

        visited.add(nodeId);
        const currentNode = nodeMap.get(nodeId);
        if (!currentNode) {
          continue;
        }

        if (currentNode.data?.kind === "action") {
          const actionResult = await executeAction(currentNode, workflow, logs);
          actionResults.push({
            nodeId: currentNode.id,
            exchange: currentNode.type,
            result: actionResult,
          });
        }

        const nextTargets = outgoingMap.get(nodeId) ?? [];
        for (const target of nextTargets) {
          queue.push(target);
        }
      }
    }

    execution.status = "success";
    execution.finishedAt = new Date();
    execution.error = "";
    execution.output = {
      workflowId: workflow._id.toString(),
      workflowName: workflow.name,
      completedAt: new Date().toISOString(),
      mode: TRADING_MODE,
      actions: actionResults,
    };
    execution.logs = logs;
    await execution.save();
  } catch (error) {
    logs.push(`Execution failed: ${error.message}`);
    execution.status = "failed";
    execution.error = error.message;
    execution.finishedAt = new Date();
    execution.logs = logs;
    await execution.save();
  }
}

async function consumeQueue() {
  if (isWorking) {
    return;
  }

  isWorking = true;
  try {
    const queuedExecutions = await WorkflowExecutionModel.find({ status: "queued" })
      .sort({ createdAt: 1 })
      .limit(5);

    for (const execution of queuedExecutions) {
      await runExecution(execution);
    }
  } finally {
    isWorking = false;
  }
}

async function boot() {
  await connectToDatabase(process.env.MONGODB_URI);
  console.log(`Worker connected. Polling every ${POLL_INTERVAL_MS}ms in ${TRADING_MODE} mode`);

  setInterval(() => {
    consumeQueue().catch((error) => {
      console.error("Worker loop error", error);
    });
  }, POLL_INTERVAL_MS);

  await consumeQueue();
}

boot().catch((error) => {
  console.error("Worker failed to start", error);
  process.exit(1);
});

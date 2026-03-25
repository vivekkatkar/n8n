import crypto from "node:crypto";
import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import { ACTION_INTEGRATIONS, SUPPORTED_ASSETS } from "commons/types";
import {
    connectToDatabase,
    CredentialModel,
    encryptSecret,
    UserModel,
    WorkflowExecutionModel,
    WorkflowModel,
} from "db/client";

const PORT = Number(process.env.PORT ?? 4000);
const JWT_SECRET = process.env.JWT_SECRET ?? "dev-secret-change-me";

const app = express();

app.use(cors());
app.use(express.json());

const SUPPORTED_TRIGGERS = [
    { id: "timer", title: "Timer", description: "triggers after x amount of interval" },
    {
        id: "price-trigger",
        title: "Price",
        description: "triggers when price goes below or up of threshold",
    },
];

const SUPPORTED_ACTIONS = ACTION_INTEGRATIONS.map((integration) => ({
    id: integration.id,
    title: integration.title,
    description: integration.description,
}));

const ACTION_IDS = new Set(SUPPORTED_ACTIONS.map((action) => action.id));
const TRIGGER_IDS = new Set(SUPPORTED_TRIGGERS.map((trigger) => trigger.id));
const ASSET_IDS = new Set(SUPPORTED_ASSETS.map((asset) => asset.id));
const ACTION_INTEGRATION_MAP = new Map(
    ACTION_INTEGRATIONS.map((integration) => [integration.id, integration]),
);

function badRequest(res, message) {
    return res.status(400).json({ error: message });
}

function unauthorized(res, message = "Unauthorized") {
    return res.status(401).json({ error: message });
}

function hashPassword(value) {
    return crypto.createHash("sha256").update(value).digest("hex");
}

function getAuthToken(req) {
    const authHeader = req.headers.authorization ?? "";
    if (!authHeader.startsWith("Bearer ")) {
        return null;
    }

    return authHeader.slice("Bearer ".length).trim();
}

function authMiddleware(req, res, next) {
    const token = getAuthToken(req);
    if (!token) {
        return unauthorized(res, "Missing bearer token");
    }

    try {
        const payload = jwt.verify(token, JWT_SECRET);
        req.user = payload;
        return next();
    } catch {
        return unauthorized(res, "Invalid or expired token");
    }
}

function normalizeUsername(value) {
    return String(value).trim().toLowerCase();
}

function toWorkflowResponse(workflowDocument) {
    return {
        id: workflowDocument._id.toString(),
        userId: workflowDocument.userId.toString(),
        name: workflowDocument.name,
        nodes: workflowDocument.nodes,
        edges: workflowDocument.edges,
        createdAt: workflowDocument.createdAt,
        updatedAt: workflowDocument.updatedAt,
    };
}

function toExecutionResponse(executionDocument) {
    return {
        id: executionDocument._id.toString(),
        workflowId: executionDocument.workflowId.toString(),
        status: executionDocument.status,
        logs: executionDocument.logs,
        output: executionDocument.output,
        error: executionDocument.error,
        startedAt: executionDocument.startedAt,
        finishedAt: executionDocument.finishedAt,
        createdAt: executionDocument.createdAt,
        updatedAt: executionDocument.updatedAt,
    };
}

function toExecutionSummaryResponse(executionDocument) {
    return {
        id: executionDocument._id.toString(),
        workflowId: executionDocument.workflowId.toString(),
        status: executionDocument.status,
        createdAt: executionDocument.createdAt,
        startedAt: executionDocument.startedAt,
        finishedAt: executionDocument.finishedAt,
        error: executionDocument.error,
    };
}

function parseDatabaseError(error) {
    if (error?.name === "CastError") {
        return "invalid id format";
    }

    if (error?.code === 11000) {
        return "duplicate value";
    }

    return "database operation failed";
}

function validateTriggerNode(node) {
    if (!TRIGGER_IDS.has(node.type)) {
        return `Unsupported trigger type: ${node.type}`;
    }

    if (node.type === "timer") {
        if (typeof node.data?.metadata?.time !== "number" || node.data.metadata.time <= 0) {
            return "Timer trigger must include a positive time value";
        }
    }

    if (node.type === "price-trigger") {
        if (typeof node.data?.metadata?.price !== "number" || node.data.metadata.price <= 0) {
            return "Price trigger must include a positive price value";
        }

        if (!ASSET_IDS.has(node.data?.metadata?.asset)) {
            return "Price trigger must include a supported asset";
        }
    }

    return null;
}

function validateActionNode(node) {
    if (!ACTION_IDS.has(node.type)) {
        return `Unsupported action type: ${node.type}`;
    }

    const qty = Number(node.data?.metadata?.qty);
    if (Number.isNaN(qty) || qty <= 0) {
        return "Action node must include a positive qty value";
    }

    if (!["long", "short"].includes(node.data?.metadata?.type)) {
        return "Action node type must be long or short";
    }

    if (!ASSET_IDS.has(node.data?.metadata?.symbol)) {
        return "Action node symbol must be one of supported assets";
    }

    return null;
}

function validateWorkflowPayload(body) {
    if (!body || !Array.isArray(body.nodes) || !Array.isArray(body.edges)) {
        return "Workflow payload must include nodes[] and edges[]";
    }

    if (body.nodes.length === 0) {
        return "Workflow must include at least one node";
    }

    const idSet = new Set();
    let triggerCount = 0;

    for (const node of body.nodes) {
        if (!node?.id || typeof node.id !== "string") {
            return "Each node must include a string id";
        }

        if (idSet.has(node.id)) {
            return `Duplicate node id: ${node.id}`;
        }

        idSet.add(node.id);

        if (node.data?.kind === "trigger") {
            triggerCount += 1;
            const error = validateTriggerNode(node);
            if (error) {
                return error;
            }
        } else if (node.data?.kind === "action") {
            const error = validateActionNode(node);
            if (error) {
                return error;
            }
        } else {
            return `Node ${node.id} must have kind 'trigger' or 'action'`;
        }
    }

    if (triggerCount === 0) {
        return "Workflow must include at least one trigger node";
    }

    for (const edge of body.edges) {
        if (!edge?.source || !edge?.target) {
            return "Each edge must include source and target";
        }

        if (!idSet.has(edge.source) || !idSet.has(edge.target)) {
            return "Each edge source and target must reference existing node ids";
        }
    }

    return null;
}

async function validateWorkflowCredentialBindings(userId, nodes) {
    const actionNodes = (nodes ?? []).filter((node) => node?.data?.kind === "action");
    const credentialIds = Array.from(
        new Set(
            actionNodes
                .map((node) => node?.data?.metadata?.credentialId)
                .filter((credentialId) => typeof credentialId === "string" && credentialId.length > 0),
        ),
    );

    if (credentialIds.length === 0) {
        return null;
    }

    const credentials = await CredentialModel.find({ _id: { $in: credentialIds }, userId });
    const credentialMap = new Map(credentials.map((credential) => [credential._id.toString(), credential]));

    for (const node of actionNodes) {
        const credentialId = node?.data?.metadata?.credentialId;
        if (!credentialId) {
            continue;
        }

        const linkedCredential = credentialMap.get(credentialId);
        if (!linkedCredential) {
            return `Action node ${node.id} references missing credential ${credentialId}`;
        }

        if (linkedCredential.exchange !== node.type) {
            return `Action node ${node.id} requires ${node.type} credential, got ${linkedCredential.exchange}`;
        }
    }

    return null;
}

function getMissingCredentialFieldsForExchange(exchange, { apiKey, apiSecret, passphrase }) {
    const integration = ACTION_INTEGRATION_MAP.get(exchange);
    if (!integration) {
        return ["exchange"];
    }

    const fields = {
        apiKey,
        apiSecret,
        passphrase,
    };

    return integration.credentials.requiredFields.filter((field) => !fields[field]);
}

function maskCredential(credential) {
    return {
        id: credential._id.toString(),
        exchange: credential.exchange,
        label: credential.label,
        createdAt: credential.createdAt,
        updatedAt: credential.updatedAt,
        hasPassphrase: Boolean(credential.passphrase),
        apiKeyPreview: credential.apiKey.slice(0, 4),
    };
}

app.post("/signup", async (req, res) => {
    const { username, password } = req.body ?? {};

    if (!username || !password) {
        return badRequest(res, "username and password are required");
    }

    const normalizedUsername = normalizeUsername(username);

    try {
        const existingUser = await UserModel.findOne({ username: normalizedUsername });
        if (existingUser) {
            return res.status(409).json({ error: "username already exists" });
        }

        const createdUser = await UserModel.create({
            username: normalizedUsername,
            passwordHash: hashPassword(password),
        });

        const token = jwt.sign(
            { userId: createdUser._id.toString(), username: createdUser.username },
            JWT_SECRET,
            { expiresIn: "7d" },
        );

        return res.status(201).json({
            token,
            user: { id: createdUser._id.toString(), username: createdUser.username },
        });
    } catch (error) {
        return res.status(500).json({ error: parseDatabaseError(error) });
    }
});

app.post("/signin", async (req, res) => {
    const { username, password } = req.body ?? {};

    if (!username || !password) {
        return badRequest(res, "username and password are required");
    }

    try {
        const existingUser = await UserModel.findOne({ username: normalizeUsername(username) });
        if (!existingUser || existingUser.passwordHash !== hashPassword(password)) {
            return unauthorized(res, "invalid username or password");
        }

        const token = jwt.sign(
            { userId: existingUser._id.toString(), username: existingUser.username },
            JWT_SECRET,
            { expiresIn: "7d" },
        );

        return res.status(200).json({
            token,
            user: { id: existingUser._id.toString(), username: existingUser.username },
        });
    } catch (error) {
        return res.status(500).json({ error: parseDatabaseError(error) });
    }
});

app.get("/me", authMiddleware, async (req, res) => {
    try {
        const existingUser = await UserModel.findById(req.user.userId);
        if (!existingUser) {
            return unauthorized(res, "user no longer exists");
        }

        return res.status(200).json({
            user: {
                id: existingUser._id.toString(),
                username: existingUser.username,
                createdAt: existingUser.createdAt,
            },
        });
    } catch (error) {
        return res.status(500).json({ error: parseDatabaseError(error) });
    }
});

app.post("/workflow", authMiddleware, async (req, res) => {
    const validationError = validateWorkflowPayload(req.body);
    if (validationError) {
        return badRequest(res, validationError);
    }

    const credentialBindingError = await validateWorkflowCredentialBindings(
        req.user.userId,
        req.body.nodes,
    );
    if (credentialBindingError) {
        return badRequest(res, credentialBindingError);
    }

    try {
        const workflow = await WorkflowModel.create({
            userId: req.user.userId,
            name: req.body?.name ?? "Untitled Workflow",
            nodes: req.body.nodes,
            edges: req.body.edges,
        });

        return res.status(201).json({ workflow: toWorkflowResponse(workflow) });
    } catch (error) {
        return res.status(500).json({ error: parseDatabaseError(error) });
    }
});

app.get("/workflows", authMiddleware, async (req, res) => {
    try {
        const workflows = await WorkflowModel.find({ userId: req.user.userId })
            .sort({ updatedAt: -1 })
            .limit(100);

        return res.status(200).json({
            workflows: workflows.map(toWorkflowResponse),
        });
    } catch (error) {
        return res.status(500).json({ error: parseDatabaseError(error) });
    }
});

app.put("/workflow", authMiddleware, async (req, res) => {
    const { workflowId, nodes, edges, name } = req.body ?? {};

    if (!workflowId) {
        return badRequest(res, "workflowId is required");
    }

    const validationError = validateWorkflowPayload({ nodes, edges });
    if (validationError) {
        return badRequest(res, validationError);
    }

    const credentialBindingError = await validateWorkflowCredentialBindings(req.user.userId, nodes);
    if (credentialBindingError) {
        return badRequest(res, credentialBindingError);
    }

    try {
        const existingWorkflow = await WorkflowModel.findById(workflowId);
        if (!existingWorkflow) {
            return res.status(404).json({ error: "workflow not found" });
        }

        if (existingWorkflow.userId.toString() !== req.user.userId) {
            return res.status(403).json({ error: "forbidden" });
        }

        existingWorkflow.name = name ?? existingWorkflow.name;
        existingWorkflow.nodes = nodes;
        existingWorkflow.edges = edges;

        const updatedWorkflow = await existingWorkflow.save();

        return res.status(200).json({ workflow: toWorkflowResponse(updatedWorkflow) });
    } catch (error) {
        return res.status(500).json({ error: parseDatabaseError(error) });
    }
});

app.get("/workflow/:workflowId", authMiddleware, async (req, res) => {
    try {
        const workflow = await WorkflowModel.findById(req.params.workflowId);
        if (!workflow) {
            return res.status(404).json({ error: "workflow not found" });
        }

        if (workflow.userId.toString() !== req.user.userId) {
            return res.status(403).json({ error: "forbidden" });
        }

        return res.status(200).json({ workflow: toWorkflowResponse(workflow) });
    } catch (error) {
        return res.status(500).json({ error: parseDatabaseError(error) });
    }
});

app.get("/workflow/executions/:workflowId", authMiddleware, async (req, res) => {
    try {
        const workflow = await WorkflowModel.findById(req.params.workflowId);
        if (!workflow) {
            return res.status(404).json({ error: "workflow not found" });
        }

        if (workflow.userId.toString() !== req.user.userId) {
            return res.status(403).json({ error: "forbidden" });
        }

        const executions = await WorkflowExecutionModel.find({ workflowId: workflow._id })
            .sort({ createdAt: -1 })
            .limit(100);

        return res.status(200).json({
            workflowId: workflow._id.toString(),
            executions: executions.map(toExecutionResponse),
        });
    } catch (error) {
        return res.status(500).json({ error: parseDatabaseError(error) });
    }
});

app.get("/executions/:executionId", authMiddleware, async (req, res) => {
    try {
        const execution = await WorkflowExecutionModel.findById(req.params.executionId);
        if (!execution) {
            return res.status(404).json({ error: "execution not found" });
        }

        const workflow = await WorkflowModel.findById(execution.workflowId);
        if (!workflow) {
            return res.status(404).json({ error: "workflow not found" });
        }

        if (workflow.userId.toString() !== req.user.userId) {
            return res.status(403).json({ error: "forbidden" });
        }

        return res.status(200).json({ execution: toExecutionResponse(execution) });
    } catch (error) {
        return res.status(500).json({ error: parseDatabaseError(error) });
    }
});

app.post("/workflow/:workflowId/run", authMiddleware, async (req, res) => {
    try {
        const workflow = await WorkflowModel.findById(req.params.workflowId);
        if (!workflow) {
            return res.status(404).json({ error: "workflow not found" });
        }

        if (workflow.userId.toString() !== req.user.userId) {
            return res.status(403).json({ error: "forbidden" });
        }

        const execution = await WorkflowExecutionModel.create({
            workflowId: workflow._id,
            status: "queued",
            logs: [
                `Execution queued at ${new Date().toISOString()}`,
                `Workflow: ${workflow.name}`,
            ],
        });

        return res.status(201).json({ execution: toExecutionSummaryResponse(execution) });
    } catch (error) {
        return res.status(500).json({ error: parseDatabaseError(error) });
    }
});

app.post("/credentials", authMiddleware, async (req, res) => {
    const { exchange, apiKey, apiSecret, passphrase, label } = req.body ?? {};

    if (!exchange || !ACTION_IDS.has(exchange)) {
        return badRequest(res, "exchange must be one of supported action ids");
    }

    const missingFields = getMissingCredentialFieldsForExchange(exchange, {
        apiKey,
        apiSecret,
        passphrase,
    });
    if (missingFields.length > 0) {
        return badRequest(res, `Missing required credential fields: ${missingFields.join(", ")}`);
    }

    try {
        const credential = await CredentialModel.create({
            userId: req.user.userId,
            exchange,
            label: label ?? `${exchange}-default`,
            apiKey: encryptSecret(apiKey),
            apiSecret: encryptSecret(apiSecret),
            passphrase: passphrase ? encryptSecret(passphrase) : "",
        });

        return res.status(201).json({ credential: maskCredential(credential) });
    } catch (error) {
        return res.status(500).json({ error: parseDatabaseError(error) });
    }
});

app.delete("/credentials/:credentialId", authMiddleware, async (req, res) => {
    try {
        const credential = await CredentialModel.findById(req.params.credentialId);
        if (!credential) {
            return res.status(404).json({ error: "credential not found" });
        }

        if (credential.userId.toString() !== req.user.userId) {
            return res.status(403).json({ error: "forbidden" });
        }

        await credential.deleteOne();
        return res.status(200).json({ success: true });
    } catch (error) {
        return res.status(500).json({ error: parseDatabaseError(error) });
    }
});

app.get("/credentials", authMiddleware, async (req, res) => {
    try {
        const currentCredentials = await CredentialModel.find({ userId: req.user.userId }).sort({
            createdAt: -1,
        });

        return res.status(200).json({ credentials: currentCredentials.map(maskCredential) });
    } catch (error) {
        return res.status(500).json({ error: parseDatabaseError(error) });
    }
});

app.get("/nodes", (_req, res) => {
    return res.status(200).json({
        triggers: SUPPORTED_TRIGGERS,
        actions: ACTION_INTEGRATIONS,
        assets: SUPPORTED_ASSETS,
    });
});

app.get("/health", (_req, res) => {
    return res.status(200).json({ ok: true });
});

connectToDatabase(process.env.MONGODB_URI)
    .then(() => {
        app.listen(PORT, () => {
            console.log(`App is running on port ${PORT}`);
        });
    })
    .catch((error) => {
        console.error("Failed to connect to database", error);
        process.exit(1);
    });
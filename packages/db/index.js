import mongoose, { Schema } from "mongoose";
import crypto from "node:crypto";

let hasConnected = false;

const ENCRYPTION_PREFIX = "encv1";
const LEGACY_ENCRYPTION_PREFIX = "enc:v1";

function getEncryptionKey() {
    const secret = process.env.CREDENTIAL_ENCRYPTION_KEY ?? "dev-only-change-me";
    return crypto.createHash("sha256").update(secret).digest();
}

export function encryptSecret(value) {
    if (!value) {
        return "";
    }

    if (typeof value !== "string") {
        throw new Error("Secret value must be a string");
    }

    if (value.startsWith(`${ENCRYPTION_PREFIX}:`) || value.startsWith(`${LEGACY_ENCRYPTION_PREFIX}:`)) {
        return value;
    }

    const key = getEncryptionKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();

    return `${ENCRYPTION_PREFIX}:${iv.toString("base64url")}:${encrypted.toString("base64url")}:${tag.toString("base64url")}`;
}

export function decryptSecret(value) {
    if (!value) {
        return "";
    }

    if (!value.startsWith(`${ENCRYPTION_PREFIX}:`) && !value.startsWith(`${LEGACY_ENCRYPTION_PREFIX}:`)) {
        return value;
    }

    let ivPart;
    let cipherPart;
    let tagPart;

    if (value.startsWith(`${ENCRYPTION_PREFIX}:`)) {
        const [prefix, iv, cipherValue, tag] = value.split(":");
        if (prefix !== ENCRYPTION_PREFIX || !iv || !cipherValue || !tag) {
            throw new Error("Invalid encrypted secret format");
        }

        ivPart = iv;
        cipherPart = cipherValue;
        tagPart = tag;
    } else {
        const [legacyPrefixA, legacyPrefixB, iv, cipherValue, tag] = value.split(":");
        if (
            legacyPrefixA !== "enc" ||
            legacyPrefixB !== "v1" ||
            !iv ||
            !cipherValue ||
            !tag
        ) {
            throw new Error("Invalid encrypted secret format");
        }

        ivPart = iv;
        cipherPart = cipherValue;
        tagPart = tag;
    }

    const key = getEncryptionKey();
    const iv = Buffer.from(ivPart, "base64url");
    const encrypted = Buffer.from(cipherPart, "base64url");
    const tag = Buffer.from(tagPart, "base64url");

    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);

    return decrypted.toString("utf8");
}

export async function connectToDatabase(connectionString) {
    const uri = connectionString ?? process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017";

    if (hasConnected && mongoose.connection.readyState === 1) {
        return mongoose.connection;
    }

    await mongoose.connect(uri, {
        dbName: process.env.MONGODB_DB ?? "trading-bot",
    });

    hasConnected = true;
    return mongoose.connection;
}

const UserSchema = new Schema(
    {
        username: {
            type: String,
            required: true,
            unique: true,
            trim: true,
            lowercase: true,
        },
        passwordHash: {
            type: String,
            required: true,
        },
    },
    {
        timestamps: true,
    },
);

const WorkflowSchema = new Schema(
    {
        userId: {
            type: mongoose.Types.ObjectId,
            required: true,
            ref: "User",
        },
        name: {
            type: String,
            default: "Untitled Workflow",
            trim: true,
        },
        nodes: {
            type: [Schema.Types.Mixed],
            default: [],
        },
        edges: {
            type: [Schema.Types.Mixed],
            default: [],
        },
    },
    {
        timestamps: true,
    },
);

const CredentialSchema = new Schema(
    {
        userId: {
            type: mongoose.Types.ObjectId,
            required: true,
            ref: "User",
        },
        exchange: {
            type: String,
            required: true,
        },
        label: {
            type: String,
            required: true,
        },
        apiKey: {
            type: String,
            required: true,
        },
        apiSecret: {
            type: String,
            required: true,
        },
        passphrase: {
            type: String,
            default: "",
        },
    },
    {
        timestamps: true,
    },
);

const WorkflowExecutionSchema = new Schema(
    {
        workflowId: {
            type: mongoose.Types.ObjectId,
            required: true,
            ref: "Workflow",
        },
        status: {
            type: String,
            enum: ["queued", "running", "success", "failed"],
            default: "queued",
        },
        logs: {
            type: [String],
            default: [],
        },
        output: {
            type: Schema.Types.Mixed,
            default: null,
        },
        error: {
            type: String,
            default: "",
        },
        startedAt: {
            type: Date,
            default: null,
        },
        finishedAt: {
            type: Date,
            default: null,
        },
    },
    {
        timestamps: true,
    },
);

export const UserModel = mongoose.models.User ?? mongoose.model("User", UserSchema);
export const WorkflowModel = mongoose.models.Workflow ?? mongoose.model("Workflow", WorkflowSchema);
export const CredentialModel =
    mongoose.models.Credential ?? mongoose.model("Credential", CredentialSchema);
export const WorkflowExecutionModel =
    mongoose.models.WorkflowExecution ??
    mongoose.model("WorkflowExecution", WorkflowExecutionSchema);
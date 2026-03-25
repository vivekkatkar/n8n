
export const SUPPORTED_ASSETS = [
    {
        id : "SOL",
        title : "SOL",
    }, 
    {
        id : "ETH",
        title : "ETH"
    },
    {
        id : "BTC",
        title : "BTC"
    }
]

export const ACTION_INTEGRATIONS = [
    {
        id: "hyperliquid",
        title: "Hyperliquid",
        description: "Place a trade on Hyperliquid",
        credentials: {
            requiredFields: ["apiKey", "apiSecret"],
            optionalFields: ["passphrase"],
        },
        api: {
            baseUrl: "https://api.hyperliquid.xyz",
            orderPath: "/exchange",
            docsUrl: "https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint",
        },
    },
    {
        id: "lighter",
        title: "Lighter",
        description: "Place a trade on Lighter",
        credentials: {
            requiredFields: ["apiKey", "apiSecret"],
            optionalFields: ["passphrase"],
        },
        api: {
            baseUrl: "https://api.lighter.xyz",
            orderPath: "/api/v1/order",
            docsUrl: "https://docs.lighter.xyz/",
        },
    },
    {
        id: "backpack",
        title: "Backpack",
        description: "Place a trade on Backpack",
        credentials: {
            requiredFields: ["apiKey", "apiSecret", "passphrase"],
            optionalFields: [],
        },
        api: {
            baseUrl: "https://api.backpack.exchange",
            orderPath: "/api/v1/order",
            docsUrl: "https://docs.backpack.exchange/",
        },
    },
];
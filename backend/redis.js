const Redis = require("ioredis");

const redis = new Redis({
    host: process.env.REDIS_HOST || "127.0.0.1",
    port: process.env.REDIS_PORT || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    // 断线自动重连配置
    retryStrategy(times) {
        // 最多重试 20 次
        if (times > 20) {
            console.error(`Redis 已重试 ${times} 次仍未连接，停止重试。请检查 Memurai 服务状态。`);
            return null; // 停止重试
        }
        // 重试间隔: min(times * 500ms, 10s)
        const delay = Math.min(times * 500, 10000);
        console.warn(`Redis 断开连接，第 ${times} 次重试，等待 ${delay}ms...`);
        return delay;
    },
    // 连接超时
    connectTimeout: 10000,
    // 命令超时（避免在有问题的连接上无限等待）
    commandTimeout: 8000,
    // 当连接断开时是否让命令失败而不是排队等待
    enableOfflineQueue: true,
    // 最大重连间隔
    maxRetriesPerRequest: 3,
    // 自动重连
    autoResubscribe: true,
    // lazyConnect 保持 false，启动时即连接
    lazyConnect: false,
});

let redisReady = false;

redis.on("connect", () => {
    redisReady = true;
    console.log("Redis 已连接");
});

redis.on("ready", () => {
    redisReady = true;
    console.log("Redis 就绪");
});

redis.on("error", (err) => {
    console.error("Redis 错误:", err && err.message || err);
    // ioredis 会自动尝试重连，这里只记录日志
});

redis.on("close", () => {
    redisReady = false;
    console.warn("Redis 连接已关闭");
});

redis.on("reconnecting", (ms) => {
    redisReady = false;
    console.warn(`Redis 正在重连，将在 ${ms}ms 后尝试...`);
});

// 暴露一个健康检查方法供外部使用
redis.isReady = () => redisReady;

module.exports = redis;

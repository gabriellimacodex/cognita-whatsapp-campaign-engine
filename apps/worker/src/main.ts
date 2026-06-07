import { Worker } from "bullmq";

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
const parsedRedisUrl = new URL(redisUrl);
const connection = {
  host: parsedRedisUrl.hostname,
  port: Number(parsedRedisUrl.port || 6379),
  username: parsedRedisUrl.username || undefined,
  password: parsedRedisUrl.password || undefined
};

const worker = new Worker(
  "campaign-jobs",
  async (job) => {
    console.log(
      JSON.stringify({
        event: "job.received",
        jobId: job.id,
        name: job.name,
        timestamp: new Date().toISOString()
      })
    );

    return { ok: true };
  },
  { connection }
);

worker.on("completed", (job) => {
  console.log(JSON.stringify({ event: "job.completed", jobId: job.id }));
});

worker.on("failed", (job, error) => {
  console.error(JSON.stringify({ event: "job.failed", jobId: job?.id, error: error.message }));
});

process.on("SIGTERM", () => {
  void worker.close();
});

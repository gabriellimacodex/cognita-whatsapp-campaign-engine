import { z } from "zod";

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_ENV: z.string().default("local"),
  APP_BASE_URL: z.string().url(),
  API_BASE_URL: z.string().url(),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  UAZAPI_BASE_URL: z.string().url(),
  UAZAPI_GABRIEL_INSTANCE_TOKEN: z.string().optional(),
  UAZAPI_GROUP_ALLOWLIST_JID: z.string().endsWith("@g.us"),
  KAPSO_BASE_URL: z.string().optional(),
  KAPSO_API_KEY: z.string().optional(),
  CAPSULE_BASE_URL: z.string().optional(),
  CAPSULE_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  SPEECH_TO_TEXT_PROVIDER: z.string().default("openai"),
  WEBHOOK_PUBLIC_BASE_URL: z.string().url(),
  WEBHOOK_SECRET: z.string().min(8),
  JWT_SECRET: z.string().min(8),
  ENCRYPTION_KEY: z.string().min(16)
});

export type AppEnv = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  return envSchema.parse(source);
}


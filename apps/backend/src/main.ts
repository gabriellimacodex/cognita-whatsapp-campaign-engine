import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import { AppModule } from "./modules/app.module.js";
import { loadEnv } from "@cognita-campaign/config";

async function bootstrap() {
  loadEnv();

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    logger: ["error", "warn", "log"]
  });

  app.enableCors({
    origin: true,
    credentials: true
  });

  await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 3001) });
}

void bootstrap();

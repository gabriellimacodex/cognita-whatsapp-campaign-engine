import { Injectable } from "@nestjs/common";
import { loadEnv } from "@cognita-campaign/config";
import type { AppEnv } from "@cognita-campaign/config";

@Injectable()
export class AppConfigService {
  readonly env: AppEnv;

  constructor() {
    this.env = loadEnv(process.env);
  }
}

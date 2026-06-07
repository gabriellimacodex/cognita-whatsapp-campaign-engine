import { Body, Controller, Post } from "@nestjs/common";
import { evaluateSendRisk, type SendPolicyContext } from "@cognita-campaign/domain";

@Controller("risk")
export class RiskController {
  @Post("evaluate")
  evaluate(@Body() body: SendPolicyContext) {
    return evaluateSendRisk({
      ...body,
      scheduledAt: new Date(body.scheduledAt),
      providerHealth: {
        ...body.providerHealth,
        checkedAt: new Date(body.providerHealth.checkedAt)
      }
    });
  }
}


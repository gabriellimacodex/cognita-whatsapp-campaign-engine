import { Body, Controller, Post } from "@nestjs/common";
import { validateWorkflowDefinition } from "@cognita-campaign/domain";

@Controller("workflow")
export class WorkflowController {
  @Post("validate")
  validate(@Body() body: unknown) {
    return validateWorkflowDefinition(body);
  }
}

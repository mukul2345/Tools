/**
 * Apply/upsert alarms: run enabled modules (ECS, API 5xx, API traffic, SQS).
 */
import { initCloudWatch } from "../core/cloudwatch.mjs";
import { runEcsAlarms } from "../modules/ecs/index.mjs";
import { runApi5xxAlarms } from "../modules/api-5xx/index.mjs";
import { runApiTrafficAlarms } from "../modules/api-traffic/index.mjs";
import { runSqsAlarms } from "../modules/sqs/index.mjs";

export async function applyAlarms(config, { dryRun = false } = {}) {
  initCloudWatch(config.aws);

  const results = { ecs: 0, "api-5xx": 0, "api-traffic": 0, sqs: 0 };

  if (config.modules.ecs) {
    results.ecs = await runEcsAlarms(config, { dryRun });
  }
  if (config.modules["api-5xx"]) {
    results["api-5xx"] = await runApi5xxAlarms(config, { dryRun });
  }
  if (config.modules["api-traffic"]) {
    results["api-traffic"] = await runApiTrafficAlarms(config, { dryRun });
  }
  if (config.modules.sqs) {
    results.sqs = await runSqsAlarms(config, { dryRun });
  }

  return results;
}

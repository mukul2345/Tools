# CloudWatch Alarms

Config-driven CloudWatch alarms for ECS, API 5xx, API traffic, and SQS. Self-contained module with no dependency on `cloudwatch-metrics-reports`.

## Setup

1. Copy the example config: `cp alarms.config.example.json alarms.config.json`
2. Edit `alarms.config.json`: set `aws.profile`, `aws.region`, `tags`, and per-module `resources` and `alarms`
3. `npm install`

## Usage

- **Apply (create/update) alarms:**  
  `node src/cli/index.mjs apply`  
  Use `--dry-run` to preview without creating.  
  Use `--config=./path/to/config.json` to use a different config file.

- **Delete alarms by tags:**  
  `node src/cli/index.mjs delete`  
  Requires `deleteFilters.Team` in config. Optionally set `deleteFilters.AlarmType` to limit to one alarm type.  
  Use `--yes` to skip the confirmation prompt.

## Modules

- **ECS:** CPU and Memory alarms (anomaly + static + composite) for configured cluster/services.
- **api-5xx:** Static-threshold 5xx % alarms per API. Uses formula `IF((m1+m2+m3)>=minimumRequestCount, (m1/(m1+m2+m3))*100, 0)` where `minimumRequestCount` is computed per API as the average of total traffic (2xx+4xx+5xx) per period over `lookbackDays`; the threshold is from historical percentile (e.g. p90). Config key `minimumRequestCount` is only used as fallback when an API has no historical data.
- **api-traffic:** Anomaly alarms for total traffic outside band per API.
- **SQS:** Supports source queues, DLQs, or both. Source queues can independently enable age and visible-backlog alarms, and DLQs can use their own prefix and visible threshold. Uses `resources.sqs.queues` (with `queueName`, `serviceName`, `kind`: `source` or `dlq`) and `alarms.sqs.source`, `alarms.sqs.dlq`, plus per-queue `overrides`.

All alarms support upsert (rerun updates thresholds and tags). Delete is filtered by `Team` (required) and optional `AlarmType`.

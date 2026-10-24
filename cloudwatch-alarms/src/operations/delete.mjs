/**
 * Delete alarms by tag filters. Team is mandatory; AlarmType optional.
 */
import {
  listAllMetricAlarms,
  listAllCompositeAlarms,
  listAlarmTags,
  deleteAlarms,
} from "../core/cloudwatch.mjs";
import { runWithConcurrency } from "../runtime/parallel.mjs";

const CONCURRENCY = 8;

export async function deleteAlarmsByTags(config, { confirm = true } = {}) {
  const filters = config.deleteFilters || {};
  const team = filters.Team;
  if (!team) {
    throw new Error("deleteFilters.Team is required for delete operation");
  }
  const alarmType = filters.AlarmType || null;

  const [metricAlarms, compositeAlarms] = await Promise.all([
    listAllMetricAlarms(),
    listAllCompositeAlarms(),
  ]);
  const allAlarms = [...metricAlarms, ...compositeAlarms];
  const alarmsWithTags = await runWithConcurrency(
    allAlarms.map((a) => () => listAlarmTags(a.AlarmArn).then((tags) => ({ alarm: a, tags }))),
    CONCURRENCY,
  );

  const tagMap = (tags) => {
    const m = {};
    for (const t of tags || []) m[t.Key] = t.Value;
    return m;
  };

  const matched = alarmsWithTags.filter(({ alarm, tags }) => {
    const m = tagMap(tags);
    if (m.Team !== team) return false;
    if (alarmType != null && m.AlarmType !== alarmType) return false;
    return true;
  });

  const toDelete = matched.map(({ alarm }) => alarm.AlarmName);
  if (toDelete.length === 0) {
    return { deleted: 0, message: "No alarms matched the tag filters." };
  }
  console.log(`Alarms to delete (${toDelete.length}):`);
  toDelete.slice(0, 50).forEach((n) => console.log("  ", n));
  if (toDelete.length > 50) console.log("  ... and", toDelete.length - 50, "more");
  if (confirm) {
    const readline = await import("readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((resolve) => {
      rl.question("Type 'yes' to confirm deletion: ", resolve);
      rl.on("close", () => resolve(""));
    });
    rl.close();
    if (answer?.trim().toLowerCase() !== "yes") {
      console.log("Aborted.");
      return { deleted: 0, message: "Aborted by user." };
    }
  }
  await deleteAlarms(toDelete);
  return { deleted: toDelete.length };
}

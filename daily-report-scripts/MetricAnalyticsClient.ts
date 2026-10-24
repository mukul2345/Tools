import { ServiceNames } from "./ExternalServiceConstants";
import { logger, serviceCaller } from "@dfg/be-stdlib";
import { DFGError } from "@dfg/be-stdlib";
import {
  ANALYTICS_OPEN_SEARCH_INDEX,
  AnalyticsBodyPayload,
} from "@dfg/core-verification-data-structure-library";
import { MetricData } from "./types";

export class MetricAnalyticsClient {
  static async fetchMetricAnalyticsData(
    payload: AnalyticsBodyPayload | ANALYTICS_OPEN_SEARCH_INDEX,
    query = "",
  ) {
    try {
      const response = await serviceCaller.post(
        ServiceNames.METRICS_ANALYTICS,
        `/dashboard/metric${query ? "?" + query : ""}`,
        { body: payload },
      );
      return response.data;
    } catch (error: any) {
      logger.error("Error in fetching metric analytics data", {
        error: error instanceof DFGError ? error.stack : error,
      });
      throw new DFGError({
        errorCode: "GEN_400",
        message: "Error in fetching metric analytics data",
        cause: error instanceof Error ? error.stack : error,
      });
    }
  }

  static async publishMetric(metricdata: MetricData) {
    try {
      await serviceCaller.post(
        ServiceNames.METRICS_ANALYTICS,
        `/metrics/critical-metric`,
        {
          body: metricdata,
        },
      );
    } catch (error) {
      logger.error("Error in publishing metric", {
        error: error instanceof DFGError ? error.stack : error,
      });
      throw new DFGError({
        errorCode: "GEN_400",
        message: "Error in publishing metric",
      });
    }
  }
}

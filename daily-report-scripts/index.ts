import "reflect-metadata";
import { logger } from "@dfg/be-stdlib";
import { MetricAnalyticsClient } from "./MetricAnalyticsClient";

interface MetricAnalyticsResponse {
  records: Array<{
    "verificationRequest.caseId": string;
    "verificationRequest.dashboardStatus": string;
    [key: string]: unknown;
  }>;
  total: number;
  data: Record<string, unknown>;
}

/**
 * Fetches dashboard statuses for a list of case IDs from the metric analytics API
 * @param caseIds - Array of case IDs to fetch dashboard statuses for
 * @returns A map of caseId to dashboardStatus
 */
export async function getDashboardStatusesByCaseIds(
  caseIds: string[],
): Promise<Map<string, string>> {
  const caseIdToStatusMap = new Map<string, string>();

  // Process case IDs in parallel for better performance
  const fetchPromises = caseIds.map(async (caseId) => {
    try {
      const payload = {
        businessObjectName: "verification-request",
        includeRecords: true,
        size: 25,
        from: 0,
        filterDimensions: [
          {
            name: "verificationRequest.caseId",
            value: caseId,
          },
        ],
      };

      const queryParams = "includeLegacy=true&trackAllHits=true";

      const response = (await MetricAnalyticsClient.fetchMetricAnalyticsData(
        payload,
        queryParams,
      )) as MetricAnalyticsResponse;

      // Extract dashboard status from the first record
      if (response.records && response.records.length > 0) {
        const dashboardStatus =
          response.records[0]["verificationRequest.dashboardStatus"];
        if (dashboardStatus) {
          caseIdToStatusMap.set(caseId, dashboardStatus);
        } else {
          logger.warn(`Dashboard status not found for caseId: ${caseId}`);
        }
      } else {
        logger.warn(`No records found for caseId: ${caseId}`);
      }
    } catch (error) {
      logger.error(`Error fetching dashboard status for caseId: ${caseId}`, {
        error,
      });
      // Continue processing other case IDs even if one fails
    }
  });

  // Wait for all API calls to complete
  await Promise.all(fetchPromises);

  // Build result map in the same order as the input caseIds array
  const orderedMap = new Map<string, string>();
  for (const caseId of caseIds) {
    const status = caseIdToStatusMap.get(caseId);
    if (status !== undefined) {
      orderedMap.set(caseId, status);
    }
  }
  return orderedMap;
}

/**
 * Fetches dashboard status for a single case ID
 * @param caseId - Case ID to fetch dashboard status for
 * @returns Dashboard status or null if not found
 */
export async function getDashboardStatusByCaseId(
  caseId: string,
): Promise<string | null> {
  const resultMap = await getDashboardStatusesByCaseIds([caseId]);
  return resultMap.get(caseId) || null;
}

async function main() {
  const caseIds = [
    "K004-260203-607B6",
    "NDOH-251223-5B7B8",
    "B003-260106-40EA5",
    "O001-260123-57EEF",
    "EDS1-260116-9D435",
    "O001-260123-4DF2E",
    "B001-260117-863A2",
    "O001-260111-AFD16",
    "N006-251113-760A2",
    "K004-251225-60C8A",
    "N006-260122-715B4",
    "H002-251201-7BF5E",
    "M004-260202-F04D0",
    "M004-260203-115A5",
    "JMC1-260117-27E45",
    "O002-260119-926DA",
    "H002-260131-1D2CA",
    "K004-260119-9FD9F",
    "N006-260109-58316",
    "EDS1-260102-8FA3F",
    "O002-260113-BAC40",
    "C001-260118-F1B0B",
    "M006-260203-9B9FF",
    "N006-260125-81941",
    "K004-260119-6F3BF",
    "M006-260202-E7148",
    "M006-260203-412CC",
    "M006-260203-9BB56",
    "H002-251204-61436",
    "O002-260120-CD663",
    "M006-260203-697A6",
    "O002-260102-A7AE1",
    "C001-260118-00B0F",
    "M006-260203-39852",
    "M006-260120-BD95C",
    "M006-260123-7CCB6",
    "M004-260129-F5C4C",
    "O001-260113-4AB80",
    "S005-260116-57E48",
    "O001-251208-F3230",
    "O001-251102-1206C",
    "K004-260119-0D594",
    "O001-260116-E1E0D",
    "M006-260203-4037E",
    "NDOH-251212-3EC92",
    "O001-260122-DA108",
    "EDS1-251229-AE1EA",
    "M006-260203-C56E1",
    "O002-260123-1677C",
    "M006-260202-90977",
    "O001-260102-95E06",
    "O002-260106-50D65",
    "N006-260126-FC3EF",
    "O002-251217-6787D",
    "M004-260128-F0953",
    "O002-260109-C6356",
    "NDOH-251110-423A9",
    "NDOH-260119-BED16",
    "M004-260202-4586B",
    "O001-260113-25DB6",
    "H002-260116-B3A49",
    "NDOH-260112-A036D",
    "O001-260123-F7678",
    "M006-260203-53AD9",
    "H002-260116-27CFE",
    "C004-251225-D8540",
    "B008-260104-F5F8D",
    "O001-251110-9701C",
    "C001-260203-FADDD",
    "M006-260103-3461C",
    "N006-260122-131EE",
    "N006-260124-9FD12",
    "M006-260203-28A0F",
    "K004-260118-0324C",
    "O002-260123-3A7A8",
    "Y001-260119-F87D9",
    "O001-260203-2238E",
    "O001-260203-3150D",
    "O001-260122-C3017",
    "NDOH-250813-0CEF0",
    "NDOH-260117-170F8",
    "O001-260123-8B3A4",
    "EDS1-260104-2511B",
    "N006-260122-33194",
    "NDOH-260116-D6386",
    "EDS1-260111-3AD22",
    "H002-260117-50DC4",
    "M004-260203-A2D3E",
    "H002-260102-CB7E7",
    "O002-251201-DF222",
    "M006-260202-64E99",
    "O002-260109-E4DB2",
    "M006-260127-E93D3",
    "O001-260120-3ED13",
    "NDOH-260117-7DBBA",
    "M006-260203-AA247",
    "O001-260114-D55EC",
    "N006-260125-A7EA5",
    "M006-260203-03AB9",
    "O001-251216-78265",
    "M004-260129-B627A",
    "K004-260127-6856D",
    "NDOH-260105-7F81B",
    "O002-260107-A040D",
    "M006-260203-FBC75",
    "M004-260203-03E0F",
    "O001-251203-0BE71",
    "N006-251107-636CA",
    "NDOH-251219-8BFF0",
    "M006-260107-94900",
    "M004-260203-CC15F",
    "H002-260203-40B0B",
    "O002-260110-A0386",
    "K004-260119-AE815",
    "M004-260203-D2E33",
    "N006-251207-56B3A",
    "N006-260126-AEC05",
    "C001-260129-12654",
    "N006-251228-BE6B4",
    "M006-260203-79904",
    "K004-251215-8F23F",
    "O001-260123-E375A",
    "NDOH-260116-84C2C",
    "N006-260123-92826",
    "B008-260117-D43E7",
    "N006-251201-A9080",
    "EDS1-260112-E7C99",
    "O001-260110-E5138",
    "M006-251203-ABA44",
    "NDOH-251103-0A3BA",
    "B003-260117-1F581",
    "M006-260203-0185B",
    "O001-260123-334C2",
    "O002-251216-03D1C",
    "H002-260113-FD319",
    "M006-260203-EA6CA",
    "M006-260203-5F99F",
    "O001-260121-DE338",
    "N006-260126-3777B",
    "M006-260118-B2EBF",
    "M006-260202-6F871",
    "O001-260124-4EC27",
    "O002-260126-CDFE6",
    "M006-251215-B932F",
    "M006-260204-8D7CC",
    "K004-260120-C1EF6",
    "N006-260127-ADD6C",
    "M004-260204-26893",
    "M006-260202-BD0A6",
    "N006-260121-A95A3",
    "O001-260126-4C8EB",
    "O002-260125-222BD",
    "C001-260119-4ED91",
    "NDOH-260120-BAC64",
    "O001-260124-53584",
    "H002-260116-2447E",
    "O002-260125-C0708",
    "N006-260120-31EDD",
    "O002-260125-3D2AF",
    "O001-260126-DEBE5",
    "EDS1-260120-807B3",
    "O002-260124-6B29D",
    "M006-260202-CFDA1",
    "O001-260126-16896",
    "O001-260119-4A7A7",
    "O001-260126-2728B",
    "E001-260127-2C732",
    "M006-260111-15D83",
    "O001-251127-38EE5",
    "M006-260109-EA52E",
    "M006-260204-0751B",
    "O001-260125-A07B0",
    "N006-260127-6940A",
    "O002-260125-79585",
    "O001-260202-67A69",
    "O002-260126-2399E",
    "M006-260203-24B37",
    "M006-260204-48EDA",
    "N006-251125-71667",
    "O002-260125-43596",
    "M006-260204-6E690",
    "O001-260131-D393E",
    "M004-260127-34A0B",
    "N006-260108-420CE",
    "O001-260122-78CAD",
    "O002-250905-F5E82",
    "O002-260126-B792A",
    "NDOH-260120-6FF63",
    "M006-260203-5655D",
    "NDOH-260120-F5AAD",
    "O001-251229-4CE2A",
    "O001-260121-47199",
    "M006-260121-B7D85",
    "C001-260106-44C8A",
    "M006-251223-9ABCD",
    "NDOH-260120-B16DE",
    "O001-260122-E5301",
    "M006-260204-8DE62",
    "N006-251207-46AD4",
    "O002-260126-58D63",
    "M006-260129-A7D72",
    "K004-260119-43DD0",
    "H002-251208-BE843",
    "NDOH-260116-0F8F8",
    "O001-260126-247FF",
    "O001-260125-3A132",
    "M006-260203-3043E",
    "O001-260125-9460A",
    "M004-260204-EE298",
    "M006-260201-92453",
    "O001-260125-05006",
    "O001-260126-B24A2",
    "NDOH-260119-698B4",
    "O001-260118-488B6",
    "O001-260124-71EEA",
    "NDOH-260120-461BB",
    "O001-260116-A27A7",
    "M004-260204-D8A40",
    "M006-260202-6D64F",
    "NDOH-260118-955A1",
    "M006-260112-FAD23",
    "NMCN-251113-FE305",
    "O001-260120-5CEFB",
    "NDOH-251202-A5ED4",
    "EDS1-260120-FC27F",
    "H002-260119-0FA98",
    "O002-260125-9E33F",
    "O001-260125-2EC42",
    "O002-260124-74C4B",
    "O002-260119-0B0CA",
    "M006-260204-90FA4",
    "NDOH-260115-0B93B",
    "M006-260204-4C4AC",
    "H002-260120-E6328",
    "M006-260204-4D5AA",
    "M006-260204-E00B7",
    "O002-251122-0275C",
    "KAAA-260120-CB285",
    "O001-260125-71F85",
    "O001-260126-666F3",
    "O001-260119-269F8",
    "M006-260115-CDB87",
    "NDOH-260120-A1570",
    "M006-251225-64C04",
    "O002-251117-AFFA6",
    "NDOH-260104-A186F",
    "O002-260125-E47B7",
    "M006-260203-7020D",
    "H002-251230-A4039",
    "O001-260125-1A874",
    "M006-260204-BA072",
    "M006-251229-AC682",
    "M004-260204-9ECF5",
    "N006-251124-29CF5",
    "M006-260204-27818",
    "O002-260123-2363E",
    "O001-260122-D5CAF",
    "M004-260202-00612",
    "NDOH-260119-D520A",
    "K004-260203-05FAB",
    "O001-260101-899C0",
    "NDOH-260119-059CF",
    "O002-260125-C229A",
    "EDS1-260120-80641",
    "N006-251203-25399",
    "M006-260204-15BD6",
    "M006-260204-FD828",
    "O002-260125-9A7A4",
    "O001-260102-9BEA5",
    "O001-251208-200A4",
    "M006-260203-04D84",
    "M006-260204-598FA",
    "N006-260123-A212D",
    "O002-260125-7CB21",
    "H002-260105-EC821",
    "O001-260121-E7EFC",
    "M006-260108-02ED5",
    "O002-260121-1099D",
    "M006-260204-DEAD7",
    "O001-260124-B132E",
    "NDOH-260120-3B87E",
    "KAAA-260120-948FB",
    "KAAA-251229-5E25B",
    "M006-260107-8A002",
    "NDOH-260120-A75FD",
    "N006-251015-8216B",
    "M004-260131-CCAE6",
    "O001-260125-EE5FC",
    "O001-260122-8B6BA",
    "H002-260113-422C4",
    "N006-251124-0D287",
    "O001-260104-AE937",
    "O001-260124-7E60B",
    "O001-260126-92F05",
    "M004-260204-04381",
    "N006-260118-90864",
    "M004-260127-E4811",
    "S005-260202-7322C",
  ];
  const statusMap = await getDashboardStatusesByCaseIds(caseIds);
  console.log(statusMap);
  const dashboardStatuses = [...statusMap.values()];
  dashboardStatuses.forEach((status) => console.log(status));
}

main();

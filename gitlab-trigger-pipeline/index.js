const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");

const GITLAB_API_BASE_URL = "https://gitlab.com/api/v4";
const PRIVATE_TOKEN =
  "glpat-KJTPij9s6eu_GtKD5gy-mG86MQp1OmM4ZzA1Cw.01.121sgss1q"; // YOUR NPM_TOKEN

const triggerCICDPipeline = async (projectId, variables) => {
  try {
    const BRANCH = "release";

    const response = await fetch(
      `${GITLAB_API_BASE_URL}/projects/${projectId}/pipeline?ref=${BRANCH}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "PRIVATE-TOKEN": PRIVATE_TOKEN,
        },
        body: JSON.stringify({
          variables: variables ?? [
            {
              key: "CI_PIPELINE_SOURCE",
              variable_type: "env_var",
              value: "web",
            },
            // {
            //   key: "ENVIRONMENT",
            //   variable_type: "env_var",
            //   value: "preprod", // preprod, training
            // },
          ],
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    console.log(data?.web_url);
  } catch (error) {
    console.log("Error in triggerCICDPipeline: ", error);
  }
};

// list of [PROJECT_ID, PROJECT_NAME]
const list = [
  /* VPT Services */
  [53419867, "Core Verification Data Structure Service"],
  [82229194, "Verification Search Service"],
  // [53419858, "Client Contract Service"],
  [53419841, "Verification Request"],
  [53504430, "Verification Workflow Engine"],
  [54932448, "Verification Initiation Service"],
  // [70348312, "POI Service"],
  //   [53582811, "Payment Service"],
  [55203022, "Document Generation Service"],
  // [53419373, "Document Management Service"],
  // [53419887, "Document Service"],
  // // [62172862, 'Jaya-Vijaya Service'],
  // [61203641, "Narada"],
  // [68203477, "Alert Service"],
  // [60366259, "Migration Service"],
  // [62583465, "Workflow Tools Service"],

  /* Services which are not part of VPT */
  // [53419302, "User Service"],
  // [53419363, "Authorization Service"],
  // [53419327, "Metrics Analytics Service"],
  // [53644988, "Geo Service"],
  // [53419183, "Notifications Service"],
  // [53419366, "Authentication Service"],
  // [57174720, "Apollo Service"],
  // [55988248, "Catalog Service"],
  // [56689807, "e-KYC Service"],
  // [55697443, "Email Monitoring Service"],
  // [54846935, "Vendor Service"],
  // [55281865, "GeoSpectrum Service"],
  // [54847863, "CTA Service"],
  // [53945401, "Applicant Service"],
  // [54447674, "Partner Service"],
  // [54468474, "Ops Service"],
  // [53419895, "IA Service"],
  // [57662934, "Audit Service"],
  // [53418855, "Garuda"],
  // [53418889, "Brahma"],
  // [57398605, "OCR Service"],
  // [58302299, "System Verification Service"],
  // [58101427, "Webscraper Wizard Service"],
  // [61018371, "Kuber"],
  // [55988248, "Catalog Service"],
  // [57662840, "Order Service"],
  // [60405184, "Ancillary partner Service"],
  // [57662913, "campaign Service"],
];

const triggerPipelines = async () => {
  for (let i = 0; i < list.length; i++) {
    await triggerCICDPipeline(list[i][0]);
  }
};

triggerPipelines();

# Component → GitLab Repo Mapping (Kiro repo-selection source)

This is the lookup Kiro uses to turn a Jira **Component** into the actual GitLab repo(s)
it should clone and edit. It is the single most important guardrail for repo selection —
keep it accurate, version-controlled, and reviewed like code.

**How Kiro uses it:** read the ticket's `Components` field → resolve each to an entry below →
only entries of `type: code` become `primary_repos`; `type: area` entries are labels, not
repos, and are ignored for cloning. If a component isn't found, the agent stops and asks
rather than guessing.

---

## Entry schema

Each component is one entry with these fields:

| Field                 | Required         | Meaning                                                                     |
| --------------------- | ---------------- | --------------------------------------------------------------------------- |
| `component`           | yes              | Exact Jira Component name (must match verbatim).                            |
| `type`                | yes              | `code` = a real editable repo; `area` = product/area label, not a repo.     |
| `repo`                | for `type: code` | GitLab repo slug the agent clones.                                          |
| `path`                | for `type: code` | Full GitLab namespace/group path (for the MCP `create_merge_request` call). |
| `default_base_branch` | for `type: code` | Fallback fork point if the ticket's `KIRO-EXEC` omits `base_branch`.        |
| `default_reviewers`   | no               | CODEOWNERS-style fallback reviewers if the ticket sets none.                |
| `context_repos`       | no               | Repos commonly needed as read-only context when editing this one.           |
| `notes`               | no               | Free text for humans.                                                       |

---

## Mapping (Markdown table form — easy to review in an MR)

| component                               | type | repo                                     | path                                                                                     | default_base_branch | default_reviewers |
| --------------------------------------- | ---- | ---------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------- | ----------------- |
| Consumer App & Services                 | area | —                                        | —                                                                                        | —                   | —                 |
| Core Platform                           | area | —                                        | —                                                                                        | —                   | —                 |
| DT-TrueProfile                          | area | —                                        | —                                                                                        | —                   | —                 |
| Internal Tools & Services               | area | —                                        | —                                                                                        | —                   | —                 |
| MIS                                     | area | —                                        | —                                                                                        | —                   | —                 |
| Product-Team                            | area | —                                        | —                                                                                        | —                   | —                 |
| QA                                      | area | —                                        | —                                                                                        | —                   | —                 |
| Verification Platform                   | area | —                                        | —                                                                                        | —                   | —                 |
| Agent-Automation                        | code | agent-management-service                 | dataflowgroup/dfg-product/agent-automation/agent-management-service                      | develop             | anuragmishra1     |
| Audit Trail Service                     | code | audit-trail-service                      | dataflowgroup/dfg-product/core-platform/audit-trail-service                              | develop             | anuragmishra1     |
| CO-BEStdLib                             | code | be-stdlib                                | dataflowgroup/dfg-product/commons/be-stdlib                                              | develop             | anuragmishra1     |
| CO-BoilerplateService                   | code | boilerplate-service                      | dataflowgroup/dfg-product/commons/boilerplate-service                                    | develop             | anuragmishra1     |
| CO-EntityLib                            | code | entity-library                           | dataflowgroup/dfg-product/commons/entity-library                                         | develop             | anuragmishra1     |
| CO-ExceptionLib                         | code | exception-library                        | dataflowgroup/dfg-product/commons/exception-library                                      | develop             | anuragmishra1     |
| CO-HermesLib                            | code | hermes                                   | dataflowgroup/dfg-product/commons/hermes                                                 | develop             | anuragmishra1     |
| CO-LoggingLib                           | code | logging-library                          | dataflowgroup/dfg-product/commons/logging-library                                        | develop             | anuragmishra1     |
| CO-MaskingLib                           | code | masking-library                          | dataflowgroup/dfg-product/commons/masking-library                                        | develop             | anuragmishra1     |
| CO-MiddlewareLib                        | code | middleware-library                       | dataflowgroup/dfg-product/commons/middleware-library                                     | develop             | anuragmishra1     |
| CO-MigrationService                     | code | migration-service                        | dataflowgroup/dfg-product/commons/migration-service                                      | develop             | anuragmishra1     |
| CO-NetworkLib                           | code | network-library                          | dataflowgroup/dfg-product/commons/network-library                                        | develop             | anuragmishra1     |
| CP-AuthentictionService                 | code | authentication-service                   | dataflowgroup/dfg-product/core-platform/authentication-service                           | develop             | anuragmishra1     |
| CP-AuthorizationService                 | code | authorization-service                    | dataflowgroup/dfg-product/core-platform/authorization-service                            | develop             | anuragmishra1     |
| CP-ConfigService                        | code | config-service                           | dataflowgroup/dfg-product/core-platform/config-service                                   | develop             | anuragmishra1     |
| CP-Data-Kit                             | code | data-kit                                 | dataflowgroup/dfg-product/core-platform/data-kit                                         | develop             | anuragmishra1     |
| CP-DocumentManagementService            | code | document-management-service              | dataflowgroup/dfg-product/core-platform/document-management-service                      | develop             | anuragmishra1     |
| CP-GeoService                           | code | geo-service                              | dataflowgroup/dfg-product/core-platform/geo-service                                      | develop             | anuragmishra1     |
| CP-GeoSpectrumService                   | code | geo-spectrum-service                     | dataflowgroup/dfg-product/core-platform/geo-spectrum-service                             | develop             | anuragmishra1     |
| CP-MetricsAnalyticsService              | code | metrics-analytics-service                | dataflowgroup/dfg-product/core-platform/metrics-analytics-service                        | develop             | anuragmishra1     |
| CP-PaymentService                       | code | payment-service                          | dataflowgroup/dfg-product/core-platform/payment-service                                  | develop             | anuragmishra1     |
| CP-ProductMetricsGenerator              | code | product-metrics-generator                | dataflowgroup/dfg-product/core-platform/product-metrics-generator                        | develop             | anuragmishra1     |
| CP-UserService                          | code | user-service                             | dataflowgroup/dfg-product/core-platform/user-service                                     | develop             | anuragmishra1     |
| CP-eKYCServce                           | code | e-kyc-service                            | dataflowgroup/dfg-product/core-platform/e-kyc-service                                    | develop             | anuragmishra1     |
| FE-Bramha                               | code | brahma                                   | dataflowgroup/dfg-product/frontend/brahma                                                | develop             | anuragmishra1     |
| FE-Garuda                               | code | garuda                                   | dataflowgroup/dfg-product/frontend/garuda                                                | develop             | anuragmishra1     |
| FE-Vishnu                               | code | vishnu                                   | dataflowgroup/dfg-product/frontend/vishnu                                                | develop             | anuragmishra1     |
| IN-Deployment                           | code | deployment                               | dataflowgroup/dfg-product/infra/deployment                                               | develop             | anuragmishra1     |
| NE-Narada                               | code | narada                                   | dataflowgroup/dfg-product/nexus/narada                                                   | develop             | anuragmishra1     |
| VP-ApplicantService                     | code | applicant-service                        | dataflowgroup/dfg-product/verification-platform/applicant-service                        | develop             | anuragmishra1     |
| VP-ClientContractService                | code | client-contract-service                  | dataflowgroup/dfg-product/verification-platform/client-contract-service                  | develop             | anuragmishra1     |
| VP-ClientService                        | code | client-service                           | dataflowgroup/dfg-product/verification-platform/client-service                           | develop             | anuragmishra1     |
| VP-CoreVerificationDataStructureLib     | code | core-verification-data-structure-library | dataflowgroup/dfg-product/verification-platform/core-verification-data-structure-library | develop             | anuragmishra1     |
| VP-CoreVerificationDataStructureService | code | core-verification-data-structure-service | dataflowgroup/dfg-product/verification-platform/core-verification-data-structure-service | develop             | anuragmishra1     |
| VP-IAService                            | code | ia-service                               | dataflowgroup/dfg-product/verification-platform/ia-service                               | develop             | anuragmishra1     |
| VP-OpsService                           | code | ops-service                              | dataflowgroup/dfg-product/verification-platform/ops-service                              | develop             | anuragmishra1     |
| VP-PartnerService                       | code | partner-service                          | dataflowgroup/dfg-product/verification-platform/partner-service                          | develop             | anuragmishra1     |
| VP-PoiService                           | code | poi-service                              | dataflowgroup/dfg-product/verification-platform/poi-service                              | develop             | anuragmishra1     |
| VP-VendorService                        | code | vendor-service                           | dataflowgroup/dfg-product/verification-platform/vendor-service                           | develop             | anuragmishra1     |
| VP-VerificationRequestService           | code | verification-request                     | dataflowgroup/dfg-product/verification-platform/verification-request                     | develop             | anuragmishra1     |
| VP-VerificationInitiationService        | code | verification-initiation-service          | dataflowgroup/dfg-product/verification-platform/verification-initiation-service          | develop             | anuragmishra1     |
| VP-VerificationSearchService            | code | verification-search-service              | dataflowgroup/dfg-product/verification-platform/verification-search-service              | develop             | anuragmishra1     |
| VP-VerificationWorkflowEngine           | code | verification-workflow-engine             | dataflowgroup/dfg-product/verification-platform/verification-workflow-engine             | develop             | anuragmishra1     |
| VP-VerificationWorkflowEngineEntity     | code | verification-workflow-engine-entity      | dataflowgroup/dfg-product/verification-platform/verification-workflow-engine-entity      | develop             | anuragmishra1     |

> Area labels (`Verification Platform`, `Core Platform`, `Internal Tools & Services`,
> `Consumer App & Services`, `Product-Team`, `QA`, `MIS`, `DT-TrueProfile`) are umbrella
> labels — not clonable repos. Kiro ignores them for cloning.

---

## Same data, structured form (what Kiro parses)

```yaml
components:
  - component: "Consumer App & Services"
    type: area

  - component: "Core Platform"
    type: area

  - component: "DT-TrueProfile"
    type: area

  - component: "Internal Tools & Services"
    type: area

  - component: "MIS"
    type: area

  - component: "Product-Team"
    type: area

  - component: "QA"
    type: area

  - component: "Verification Platform"
    type: area

  - component: "Agent-Automation"
    type: code
    repo: agent-management-service
    path: dataflowgroup/dfg-product/agent-automation/agent-management-service
    default_base_branch: develop
    default_reviewers: [anuragmishra1, thangavelramasamy]

  - component: "Audit Trail Service"
    type: code
    repo: audit-trail-service
    path: dataflowgroup/dfg-product/core-platform/audit-trail-service
    default_base_branch: develop
    default_reviewers: [anuragmishra1]

  - component: "CO-BEStdLib"
    type: code
    repo: be-stdlib
    path: dataflowgroup/dfg-product/commons/be-stdlib
    default_base_branch: develop
    default_reviewers: [anuragmishra1]

  - component: "CO-BoilerplateService"
    type: code
    repo: boilerplate-service
    path: dataflowgroup/dfg-product/commons/boilerplate-service
    default_base_branch: develop
    default_reviewers: [anuragmishra1]

  - component: "CO-EntityLib"
    type: code
    repo: entity-library
    path: dataflowgroup/dfg-product/commons/entity-library
    default_base_branch: develop
    default_reviewers: [anuragmishra1]

  - component: "CO-ExceptionLib"
    type: code
    repo: exception-library
    path: dataflowgroup/dfg-product/commons/exception-library
    default_base_branch: develop
    default_reviewers: [anuragmishra1]

  - component: "CO-HermesLib"
    type: code
    repo: hermes
    path: dataflowgroup/dfg-product/commons/hermes
    default_base_branch: develop
    default_reviewers: [anuragmishra1]

  - component: "CO-LoggingLib"
    type: code
    repo: logging-library
    path: dataflowgroup/dfg-product/commons/logging-library
    default_base_branch: develop
    default_reviewers: [anuragmishra1]

  - component: "CO-MaskingLib"
    type: code
    repo: masking-library
    path: dataflowgroup/dfg-product/commons/masking-library
    default_base_branch: develop
    default_reviewers: [anuragmishra1]

  - component: "CO-MiddlewareLib"
    type: code
    repo: middleware-library
    path: dataflowgroup/dfg-product/commons/middleware-library
    default_base_branch: develop
    default_reviewers: [anuragmishra1]

  - component: "CO-MigrationService"
    type: code
    repo: migration-service
    path: dataflowgroup/dfg-product/commons/migration-service
    default_base_branch: develop
    default_reviewers: [anuragmishra1]

  - component: "CO-NetworkLib"
    type: code
    repo: network-library
    path: dataflowgroup/dfg-product/commons/network-library
    default_base_branch: develop
    default_reviewers: [anuragmishra1]

  - component: "CP-AuthentictionService"
    type: code
    repo: authentication-service
    path: dataflowgroup/dfg-product/core-platform/authentication-service
    default_base_branch: develop
    default_reviewers: [anuragmishra1]

  - component: "CP-AuthorizationService"
    type: code
    repo: authorization-service
    path: dataflowgroup/dfg-product/core-platform/authorization-service
    default_base_branch: develop
    default_reviewers: [anuragmishra1]

  - component: "CP-ConfigService"
    type: code
    repo: config-service
    path: dataflowgroup/dfg-product/core-platform/config-service
    default_base_branch: develop
    default_reviewers: [anuragmishra1]

  - component: "CP-Data-Kit"
    type: code
    repo: data-kit
    path: dataflowgroup/dfg-product/core-platform/data-kit
    default_base_branch: develop
    default_reviewers: [anuragmishra1]

  - component: "CP-DocumentManagementService"
    type: code
    repo: document-management-service
    path: dataflowgroup/dfg-product/core-platform/document-management-service
    default_base_branch: develop
    default_reviewers: [anuragmishra1]

  - component: "CP-GeoService"
    type: code
    repo: geo-service
    path: dataflowgroup/dfg-product/core-platform/geo-service
    default_base_branch: develop
    default_reviewers: [anuragmishra1]

  - component: "CP-GeoSpectrumService"
    type: code
    repo: geo-spectrum-service
    path: dataflowgroup/dfg-product/core-platform/geo-spectrum-service
    default_base_branch: develop
    default_reviewers: [anuragmishra1]

  - component: "CP-MetricsAnalyticsService"
    type: code
    repo: metrics-analytics-service
    path: dataflowgroup/dfg-product/core-platform/metrics-analytics-service
    default_base_branch: develop
    default_reviewers: [anuragmishra1]

  - component: "CP-PaymentService"
    type: code
    repo: payment-service
    path: dataflowgroup/dfg-product/core-platform/payment-service
    default_base_branch: develop
    default_reviewers: [anuragmishra1]

  - component: "CP-ProductMetricsGenerator"
    type: code
    repo: product-metrics-generator
    path: dataflowgroup/dfg-product/core-platform/product-metrics-generator
    default_base_branch: develop
    default_reviewers: [anuragmishra1]

  - component: "CP-UserService"
    type: code
    repo: user-service
    path: dataflowgroup/dfg-product/core-platform/user-service
    default_base_branch: develop
    default_reviewers: [anuragmishra1]

  - component: "CP-eKYCServce"
    type: code
    repo: e-kyc-service
    path: dataflowgroup/dfg-product/core-platform/e-kyc-service
    default_base_branch: develop
    default_reviewers: [anuragmishra1]

  - component: "FE-Bramha"
    type: code
    repo: brahma
    path: dataflowgroup/dfg-product/frontend/brahma
    default_base_branch: develop
    default_reviewers: [anuragmishra1]

  - component: "FE-Garuda"
    type: code
    repo: garuda
    path: dataflowgroup/dfg-product/frontend/garuda
    default_base_branch: develop
    default_reviewers: [anuragmishra1]

  - component: "FE-Vishnu"
    type: code
    repo: vishnu
    path: dataflowgroup/dfg-product/frontend/vishnu
    default_base_branch: develop
    default_reviewers: [anuragmishra1]

  - component: "IN-Deployment"
    type: code
    repo: deployment
    path: dataflowgroup/dfg-product/infra/deployment
    default_base_branch: develop
    default_reviewers: [anuragmishra1]

  - component: "NE-Narada"
    type: code
    repo: narada
    path: dataflowgroup/dfg-product/nexus/narada
    default_base_branch: develop
    default_reviewers: [anuragmishra1]

  - component: "VP-ApplicantService"
    type: code
    repo: applicant-service
    path: dataflowgroup/dfg-product/verification-platform/applicant-service
    default_base_branch: develop
    default_reviewers: [anuragmishra1]

  - component: "VP-ClientContractService"
    type: code
    repo: client-contract-service
    path: dataflowgroup/dfg-product/verification-platform/client-contract-service
    default_base_branch: develop
    default_reviewers: [anuragmishra1]

  - component: "VP-ClientService"
    type: code
    repo: client-service
    path: dataflowgroup/dfg-product/verification-platform/client-service
    default_base_branch: develop
    default_reviewers: [anuragmishra1]

  - component: "VP-CoreVerificationDataStructureLib"
    type: code
    repo: core-verification-data-structure-library
    path: dataflowgroup/dfg-product/verification-platform/core-verification-data-structure-library
    default_base_branch: develop
    default_reviewers: [anuragmishra1]

  - component: "VP-CoreVerificationDataStructureService"
    type: code
    repo: core-verification-data-structure-service
    path: dataflowgroup/dfg-product/verification-platform/core-verification-data-structure-service
    default_base_branch: develop
    default_reviewers: [anuragmishra1]

  - component: "VP-IAService"
    type: code
    repo: ia-service
    path: dataflowgroup/dfg-product/verification-platform/ia-service
    default_base_branch: develop
    default_reviewers: [anuragmishra1]

  - component: "VP-OpsService"
    type: code
    repo: ops-service
    path: dataflowgroup/dfg-product/verification-platform/ops-service
    default_base_branch: develop
    default_reviewers: [anuragmishra1]

  - component: "VP-PartnerService"
    type: code
    repo: partner-service
    path: dataflowgroup/dfg-product/verification-platform/partner-service
    default_base_branch: develop
    default_reviewers: [anuragmishra1]

  - component: "VP-PoiService"
    type: code
    repo: poi-service
    path: dataflowgroup/dfg-product/verification-platform/poi-service
    default_base_branch: develop
    default_reviewers: [anuragmishra1]

  - component: "VP-VendorService"
    type: code
    repo: vendor-service
    path: dataflowgroup/dfg-product/verification-platform/vendor-service
    default_base_branch: develop
    default_reviewers: [anuragmishra1]

  - component: "VP-VerificationRequestService"
    type: code
    repo: verification-request
    path: dataflowgroup/dfg-product/verification-platform/verification-request
    default_base_branch: develop
    default_reviewers: [anuragmishra1]

  - component: "VP-VerificationInitiationService"
    type: code
    repo: verification-initiation-service
    path: dataflowgroup/dfg-product/verification-platform/verification-initiation-service
    default_base_branch: develop
    default_reviewers: [anuragmishra1]

  - component: "VP-VerificationSearchService"
    type: code
    repo: verification-search-service
    path: dataflowgroup/dfg-product/verification-platform/verification-search-service
    default_base_branch: develop
    default_reviewers: [anuragmishra1]

  - component: "VP-VerificationWorkflowEngine"
    type: code
    repo: verification-workflow-engine
    path: dataflowgroup/dfg-product/verification-platform/verification-workflow-engine
    default_base_branch: develop
    default_reviewers: [anuragmishra1]

  - component: "VP-VerificationWorkflowEngineEntity"
    type: code
    repo: verification-workflow-engine-entity
    path: dataflowgroup/dfg-product/verification-platform/verification-workflow-engine-entity
    default_base_branch: develop
    default_reviewers: [anuragmishra1]
```

---

## Shared packages (private npm registry)

These are cross-repo contract libraries published to our private GitLab npm registry. When a fix
requires changing a **published type/contract**, the change happens in the **package repo**, not
inline in the consuming service. Package repos follow a **different flow** from component repos:

- **Branching:** always fork a feature branch from **`master`** and merge back to `master`
  (component repos default to `develop`).
- **Release:** the package is **published only when its MR is merged to `master`**. During
  development, consuming repos use a local `pnpm link` so builds/tests pass before publish.
- **Cross-MR dependency:** the consuming repo's MR **depends on** the package MR — it must not be
  merged until the package MR is merged and the new version published.

| package (npm)                               | repo                                     | path                                                                                     | registry package id | base_branch |
| ------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------- | ----------- |
| `@dfg/entity-library`                       | entity-library                           | dataflowgroup/dfg-product/commons/entity-library                                         | 63403548            | master      |
| `@dfg/verification-workflow-engine-entity`  | verification-workflow-engine-entity      | dataflowgroup/dfg-product/verification-platform/verification-workflow-engine-entity      | 63400827            | master      |
| `@dfg/brahma-types`                         | vishnu                                    | dataflowgroup/dfg-product/frontend/vishnu                                                 | 63393760            | master      |
| `@dfg/cdkraft`                              | cdkraft                                  | dataflowgroup/dfg-product/infra/cdkraft                                                   | 63341428            | master      |
| `@dfg/core-verification-data-structure-library` | core-verification-data-structure-library | dataflowgroup/dfg-product/verification-platform/core-verification-data-structure-library | 62566818        | master      |
| `@dfg/be-stdlib`                            | be-stdlib                                | dataflowgroup/dfg-product/commons/be-stdlib                                               | 62277658            | master      |
| `@dfg/data-kit`                             | data-kit                                 | dataflowgroup/dfg-product/core-platform/data-kit                                          | 62652108            | master      |

```yaml
packages:
  - package: "@dfg/entity-library"
    repo: entity-library
    path: dataflowgroup/dfg-product/commons/entity-library
    registry_id: 63403548
    base_branch: master
  - package: "@dfg/verification-workflow-engine-entity"
    repo: verification-workflow-engine-entity
    path: dataflowgroup/dfg-product/verification-platform/verification-workflow-engine-entity
    registry_id: 63400827
    base_branch: master
  - package: "@dfg/brahma-types"
    repo: vishnu
    path: dataflowgroup/dfg-product/frontend/vishnu
    registry_id: 63393760
    base_branch: master
  - package: "@dfg/cdkraft"
    repo: cdkraft
    path: dataflowgroup/dfg-product/infra/cdkraft
    registry_id: 63341428
    base_branch: master
  - package: "@dfg/core-verification-data-structure-library"
    repo: core-verification-data-structure-library
    path: dataflowgroup/dfg-product/verification-platform/core-verification-data-structure-library
    registry_id: 62566818
    base_branch: master
  - package: "@dfg/be-stdlib"
    repo: be-stdlib
    path: dataflowgroup/dfg-product/commons/be-stdlib
    registry_id: 62277658
    base_branch: master
  - package: "@dfg/data-kit"
    repo: data-kit
    path: dataflowgroup/dfg-product/core-platform/data-kit
    registry_id: 62652108
    base_branch: master
```

> A package's source often lives in a repo that is ALSO a component repo (e.g. `be-stdlib`,
> `entity-library`, `data-kit`). The distinction is *what* you change: a change to a **published
> type/contract** = package flow (master, version bump, changelog, publish-on-merge); a change to
> that service's own runtime code = normal component flow.

---

## Resolution rules (encode these in the Kiro prompt/hook)

1. Read every value in the ticket's `Components` field.
2. Look up each against `component` (exact match, case-sensitive).
3. Collect `type: code` entries → these are candidate `primary_repos`.
4. Ignore `type: area` entries for cloning (they're context labels only).
5. If the ticket's `KIRO-EXEC` lists `primary_repos` explicitly, it **overrides** — but every
   listed repo must still exist in this map (reject unknown repos).
6. If a component is missing from the map, **halt and ask** — never guess a repo.
7. Fill `base_branch` / `reviewers` from the ticket first; fall back to the map's
   `default_base_branch` / `default_reviewers` only when the ticket is silent.

---

## Maintenance

Store this file in a repo (e.g. a `tooling/` or `kiro-config/` repo) and require an MR to
change it. When a new service/component is added, adding its mapping entry should be part of
the definition-of-done — otherwise agent-eligible tickets for that component will halt at
rule 6.

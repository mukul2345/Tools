import { WorkflowApiClient } from '../api-client.js';
import { handleApiError, McpToolError } from '../errors.js';

/**
 * Valid entity types supported by the workflow-tools-service explorer filter endpoint.
 * Sourced from ExplorerEntityType enum in workflow-tools-service.
 */
export const VALID_ENTITY_TYPES = [
  'Workflow',
  'WorkflowDependency',
  'AuditTrail',
  'WorkflowRun',
  'VerificationResponse',
  'ValidationResponse',
  'ReportQCResponse',
  'VerificationQCResponse',
  'IssuingAuthorityPayment',
  'IssuingAuthorityOfficeV2',
  'IssuingAuthorityIssuedComponents',
  'IssuingAuthorityVerifierDetails',
  'IssuingAuthorityComponentsRequirementListV3',
  'IssuingAuthorityVerificationPaymentFeesV2',
  'IssuingAuthorityInitiationConfiguration',
  'PastOfficeAddress',
  'IssuingAuthorityPaymentsDetails',
  'IssuingAuthorityVerificationDetails',
  'IssuingAuthorityDegreeOffered',
  'ResponseInsufficiency',
  'IAInsufficiency',
  'ClaimItem',
  'Component',
  'VerificationRequest',
  'VerificationRequestResponse',
  'Report',
  'CaseDetailsInsufficiency',
  'VerificationRequestPayment',
  'VerificationRequestPaymentContract',
  'CaseRecord',
  'ReVerificationInvocationData',
  'AttributeV2',
  'FollowUp',
  'PaymentContract',
  'DFGPaymentTransaction',
  'IAPayout',
  'RefundPayout',
  'VRDocCreationRequest',
  'DocGenerationRequest',
  'AddonContract',
  'AddonConfig',
  'AddonVerificationRequestMapping',
  'ClientVerificationContract',
  'IAOAdditionalDetails',
  'KVPair',
  'Client',
  'User',
  'Applicant',
  'Partner',
  'PartnerUser',
  'OpsUser',
] as const;

export const queryEntitiesTools = [
  {
    name: 'query_entities',
    description:
      'Search entities by type and filter criteria. Supports all entity types in the workflow system including Workflow, ClaimItem, VerificationRequest, AuditTrail, and many more. Use this to locate specific records across the system.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entityType: {
          type: 'string',
          description: `The entity type to query. Must be one of: ${VALID_ENTITY_TYPES.join(', ')}`,
        },
        filter: {
          type: 'object',
          description:
            'Entity-specific filter fields as key-value pairs (e.g., { "id": "some-id", "status": "ACTIVE" })',
          additionalProperties: { type: 'string' },
        },
        pageSize: {
          type: 'number',
          description: 'Number of results per page (default: 20)',
        },
        lastEvaluatedKey: {
          type: 'object',
          description: 'Pagination cursor from a previous response to fetch the next page',
        },
        sortKey: {
          type: 'string',
          description: 'Field to sort by (e.g., "createdAt" or "updatedAt")',
        },
        sortDirection: {
          type: 'string',
          description: 'Sort direction: "ASC" or "DESC"',
          enum: ['ASC', 'DESC'],
        },
      },
      required: ['entityType'],
    },
  },
];

export async function handleQueryEntitiesTool(
  args: Record<string, unknown>,
  apiClient: WorkflowApiClient
) {
  const entityType = args.entityType as string | undefined;

  if (!entityType || entityType.trim() === '') {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: 'VALIDATION_ERROR',
            message: 'Missing required parameter: entityType',
          }),
        },
      ],
      isError: true,
    };
  }

  if (!VALID_ENTITY_TYPES.includes(entityType as (typeof VALID_ENTITY_TYPES)[number])) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: 'VALIDATION_ERROR',
            message: `Invalid entityType: "${entityType}". Valid types are: ${VALID_ENTITY_TYPES.join(', ')}`,
          }),
        },
      ],
      isError: true,
    };
  }

  const filter = (args.filter as Record<string, string>) ?? undefined;
  const pageSize = args.pageSize as number | undefined;
  const lastEvaluatedKey = args.lastEvaluatedKey as unknown;
  const sortKey = args.sortKey as string | undefined;
  const sortDirection = args.sortDirection as string | undefined;

  try {
    const result = await apiClient.queryEntities(entityType, filter, {
      size: pageSize,
      lastEvaluatedKey,
      sortKey,
      sortDirection,
    });

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    return handleApiError(error);
  }
}

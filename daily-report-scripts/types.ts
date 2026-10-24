import {
    AgentVerificationRequestResponse,
    Client,
    ClientContract,
    Currency,
    PackageContractInfo,
    PreValidationResponse,
    Price,
    VerificationRequest,
    VerificationRequestPaymentContract,
    FollowUpType,
} from '@dfg/core-verification-data-structure-library';
import {Entity} from '@dfg/entity-library';
import {Workflow} from '@dfg/verification-workflow-engine-entity';

export type VerificationRequestPaymentDetails = {
    filteredVerificationRequestPaymentContract: VerificationRequestPaymentContract[];
    verificationRequestPaymentContract: VerificationRequestPaymentContract[];
    applicantId: string;
};

export type IAPaymentContractDetails = {
    totalAmount: number;
    iApaymentContractIds: string[];
};

export type ValidationStartPaymentTransaction = {
    verificationRequest: VerificationRequest;
    clientContract?: ClientContract;
    client?: Client;
    currencyCode: string;
    workflow?: Workflow;
    caseCreationWorkflow?: Workflow;
};

export type PostPaymentDetailsFilter = {
    ids?: string[];
    verificationRequestId?: string;
    partnerId?: string;
    paymentTransactionId?: string;
};

export type PaymentDetails = {
    taxPercentage: number;
    contractCurrency: string;
    taxLabel: string;
    clientName: string;
};

export type UserDetails = {
    userId: string;
    userName: string;
    userEmail: string;
    salutation: string;
};

export type VRPaymentContractDetails = {
    basePaymentContractRecords: PackageContractInfo[];
    itemsIds: string[];
    reportTransferFee: Price;
    reportTrasferItemChildIds: string[];
    reportTransferItemsExists: boolean;
    reportSharingFee: Price;
    reportSharingItemsExists: boolean;
    additionalPaymentContractRecords: any[];
    addOnComponentRecords: any[];
    reIssueReportRecords: any[];
    reportSharingFeeRecords: any[];
    paymentType: any;
    taxLabel: string;
    taxPercentage: number;
};

export type ParentReportDocumentsValidation = {
    verificationRequestId: string;
    isValid: boolean;
};

export type PendingContractCreationType = {
    amountInOriginalCurrency: number;
    amountInBaseCurrency: number;
    originalCurrency: Currency;
    baseCurrency: Currency;
    conversionRate: number;
    issuingAuthorityName: string;
    taxPercentage: number;
    processingFeePercentage: number;
};

export interface Dimension {
    Name: string;
    Value: string;
}

export interface MetricData {
    metricName: string;
    value: number | boolean;
    unit?: string;
    dimensions: Dimension[];
}

export enum AgentMetricType {
    AGENT_REJECTED_VQC_SKIPPED = 'AGENT_REJECTED_VQC_SKIPPED',
    AGENT_REJECTED_VQC_CLEARED = 'AGENT_REJECTED_VQC_CLEARED',
    AGENT_REJECTED_VQC_REJECTED = 'AGENT_REJECTED_VQC_REJECTED',
    AGENT_CLEARED_RQC_REJECTED = 'AGENT_CLEARED_RQC_REJECTED',
    AGENT_CLEARED_RQC_CLEARED = 'AGENT_CLEARED_RQC_CLEARED',
    // First Upload Events
    APPLICANT_FIRST_UPLOAD_CORRECT = 'APPLICANT_FIRST_UPLOAD_CORRECT',
    APPLICANT_FIRST_UPLOAD_INCORRECT = 'APPLICANT_FIRST_UPLOAD_INCORRECT',
    APPLICANT_FIRST_UPLOAD_ANALYSIS_FAILED = 'APPLICANT_FIRST_UPLOAD_ANALYSIS_FAILED',
    APPLICANT_FIRST_UPLOAD_UNSUPPORTED_DOCUMENT = 'APPLICANT_FIRST_UPLOAD_UNSUPPORTED_DOCUMENT',
    APPLICANT_FIRST_UPLOAD_CORRECT_VALIDATOR_ACCEPTED = 'APPLICANT_FIRST_UPLOAD_CORRECT_VALIDATOR_ACCEPTED',
    APPLICANT_FIRST_UPLOAD_CORRECT_VALIDATOR_REJECTED = 'APPLICANT_FIRST_UPLOAD_CORRECT_VALIDATOR_REJECTED',

    // System Resolved Events
    SYSTEM_RESOLVED_DOC_INSUFF = 'SYSTEM_RESOLVED_DOC_INSUFF',
    SYSTEM_RESOLVED_DOC_INSUFF_VALIDATOR_ACCEPTED = 'SYSTEM_RESOLVED_DOC_INSUFF_VALIDATOR_ACCEPTED',
    SYSTEM_RESOLVED_DOC_INSUFF_VALIDATOR_REJECTED = 'SYSTEM_RESOLVED_DOC_INSUFF_VALIDATOR_REJECTED',

    // Re-upload Events
    APPLICANT_RE_UPLOAD_CORRECT = 'APPLICANT_RE_UPLOAD_CORRECT',
    APPLICANT_RE_UPLOAD_CORRECT_VALIDATOR_ACCEPTED = 'APPLICANT_RE_UPLOAD_CORRECT_VALIDATOR_ACCEPTED',
    APPLICANT_RE_UPLOAD_CORRECT_VALIDATOR_REJECTED = 'APPLICANT_RE_UPLOAD_CORRECT_VALIDATOR_REJECTED',
    APPLICANT_RE_UPLOAD_INCORRECT = 'APPLICANT_RE_UPLOAD_INCORRECT',
    APPLICANT_RE_UPLOAD_INCORRECT_VALIDATOR_ACCEPTED = 'APPLICANT_RE_UPLOAD_INCORRECT_VALIDATOR_ACCEPTED',
    APPLICANT_RE_UPLOAD_INCORRECT_VALIDATOR_REJECTED = 'APPLICANT_RE_UPLOAD_INCORRECT_VALIDATOR_REJECTED',
    APPLICANT_RE_UPLOAD_ANALYSIS_FAILED = 'APPLICANT_RE_UPLOAD_ANALYSIS_FAILED',
    APPLICANT_RE_UPLOAD_UNSUPPORTED_DOCUMENT = 'APPLICANT_RE_UPLOAD_UNSUPPORTED_DOCUMENT',
    APPLICANT_RE_UPLOAD = 'APPLICANT_RE_UPLOAD',
}

export enum InitializerType {
    VERIFICATION_QC_MANUAL_RESPONSE = 'VERIFICATION_QC_MANUAL_RESPONSE',
    VERIFICATION_QC_BOT_RESPONSE = 'VERIFICATION_QC_BOT_RESPONSE',
    REPORT_QC_RESPONSE = 'REPORT_QC_RESPONSE',
}

export enum AnalysisContext {
    APPLICANT_UPLOADED = 'APPLICANT_UPLOADED',
    SYSTEM_RESOLVED_DOCUMENT_INSUFF = 'SYSTEM_RESOLVED_DOCUMENT_INSUFF',
    VALIDATOR_RESPONSE = 'VALIDATOR_RESPONSE',
    SYSTEM_RESOLVED_VALIDATOR_RESPONSE = 'SYSTEM_RESOLVED_VALIDATOR_RESPONSE',
}

export enum MetricName {
    FULL_QC_PERFORMANCE = 'FULL_QC_PERFORMANCE',
    AUTOMATED_DOC_IN_SUFFICIENCY = 'AUTOMATED_DOC_IN_SUFFICIENCY',
}

export enum MetricDimension {
    AGENT_METRIC_TYPE = 'AgentMetricType',
    CLIENT_NAME = 'ClientName',
    COMPONENT_TYPE_ID = 'ComponentTypeId',
}

export enum ValidatorDecision {
    ACCEPTED = 'ACCEPTED',
    REJECTED = 'REJECTED',
}

export interface UpdateReportOptions {
    allowPublishedUpdate?: boolean;
}

export interface InitiatePreValidationResponse extends Entity {
    preValidationResponses: PreValidationResponse;
    agentVerificationRequestResponse: AgentVerificationRequestResponse;
}

// FollowUp Lookup Key Types
export interface LookupKeyParams {
    type: FollowUpType;
    verifierId?: string;
    verifierEntityId?: string;
    initiatedByOpsId?: string;
    vendorId?: string;
    issuingAuthorityOfficeId?: string;
}

export interface FollowUpLookupKeyParams extends LookupKeyParams {
    status?: string;
}

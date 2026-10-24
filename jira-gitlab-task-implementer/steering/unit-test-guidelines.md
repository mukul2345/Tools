---
inclusion: fileMatch
fileMatchPattern: "**/*.test.ts"
---

# Unit Test Guidelines

Standards for writing and modifying unit tests in VPT TypeScript services. These apply whenever
a `*.test.ts` file is created or edited.

## Mocking

- **Use `jest.spyOn` only.** Do NOT use `jest.mock(...)` or `jest.fn()`.
- Mock at the **boundary** (external service clients, database/DynamoDB accessors, AWS SDKs).
  Never mock what we own internally — if an internal collaborator needs mocking, it usually needs
  a better interface (constructor injection).

```typescript
// ✅ Correct: spy on a boundary method
const getVerificationRequestSpy = jest.spyOn(
  VerificationRequestServiceClient.prototype,
  'getVerificationRequestById',
).mockResolvedValue(mockVerificationRequest);

// ❌ Wrong
jest.mock('../clients/VerificationRequestServiceClient');
const fn = jest.fn();
```

## What to test (and what not to)

- **No tests for private methods or properties.** Exercise behaviour through the public API. If a
  private value genuinely must be asserted or seeded, add a proper getter/setter rather than
  reaching into internals.
- **Cover all cases:** happy path first, then edge cases, then error paths.
- **Do NOT assert on loggers.** No expectations on `logger.info` / `logger.warn` / `logger.error`
  calls — logging is not behaviour under test.

## Types

- **No `any`.** Use precise types for mocks, fixtures, and assertions.
- **No `unknown`** either — tolerated only when a precise type is genuinely impossible, and then
  it must be justified. Treat it as a last resort.

## Test data / fixtures

- **Mock data lives in a separate file**, not inline in the test body:
  - complex objects → a `*.test.json` fixture loaded in the test, or
  - a dedicated `*.mock.ts` module exporting typed factory functions.
- Prefer typed factory functions with `Partial<T>` overrides for simple objects.

```typescript
// mockData.mock.ts
export function createMockWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return { id: 'WF-test-001', status: WorkflowStatus.ACTIVE, ...overrides };
}
```

## Structure & naming

- **AAA** — Arrange / Act / Assert, with blank-line separation.
- One behaviour per `it`. Name as `should <expected behavior> when <condition/scenario>`.
- Group by method with `describe`; reset state in `beforeEach` / `afterEach` — no test
  interdependencies (tests must pass in any order).

```typescript
describe('ReportGenerationHelper', () => {
  describe('generateAppealOrErrorCorrectionReportData', () => {
    it('should use CaseRecord.reportId as baseline when it differs from the original VR snapshot', async () => {
      // Arrange
      // Act
      // Assert
    });
  });
});
```

## Coverage of changes

- Every new or changed line/branch introduced by the fix must be covered.
- Coverage is measured per changed file; the goal is **no regression** vs. the pre-change
  baseline and full coverage of the change itself (raising unrelated legacy coverage is not
  required). See the run loop's verify step for how baseline vs. current is measured and reported.

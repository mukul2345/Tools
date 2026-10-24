---
inclusion: fileMatch
fileMatchPattern: "**/*.test.ts"
---

# Unit Test Guidelines

Standards for writing and modifying unit tests in VPT TypeScript services. These apply whenever
a `*.test.ts` file is created or edited.

## Mocking

- **Use `jest.spyOn` only.** Do NOT use `jest.fn()`, `jest.mocked()`, or `jest.mock(...)`.
- **Do not use `require(...)` inside a `spyOn` call.** Import the module/object at the top of the
  file and spy on the imported reference.
- **Do not use `.prototype` for mocking or object manipulation.** Spy on the actual instance or the
  imported object/module, not on the class prototype. (Constructor injection makes the collaborating
  instance available to spy on directly.)
- Mock at the **boundary** (external service clients, database/DynamoDB accessors, AWS SDKs).
  Never mock what we own internally — if an internal collaborator needs mocking, it usually needs
  a better interface (constructor injection).
- **Do not mock private functions.** Focus on testing public behaviour; private logic is exercised
  through the public API.
- **Mock only necessary functions.** Avoid mocking utility methods until it is genuinely necessary —
  prefer letting owned utilities run for real.
- **All external dependencies must be mocked** — database access, API calls, and file I/O must be
  mocked with `jest.spyOn()` so the test never touches the real service or resource.

```typescript
// ✅ Correct: spy on the injected instance (or imported object), not the prototype
const client = new VerificationRequestServiceClient(config);
const getVerificationRequestSpy = jest
  .spyOn(client, 'getVerificationRequestById')
  .mockResolvedValue(mockVerificationRequest);

// ❌ Wrong
jest.mock('../clients/VerificationRequestServiceClient');
const fn = jest.fn();
const spy = jest.mocked(client).getVerificationRequestById;
jest.spyOn(VerificationRequestServiceClient.prototype, 'getVerificationRequestById');
jest.spyOn(require('../clients/Client'), 'method');
```

## What to test (and what not to)

- **No tests for private methods or properties.** Exercise behaviour through the public API. If a
  private value genuinely must be asserted or seeded, add a proper getter/setter rather than
  reaching into internals.
- **Cover all cases:** happy path first, then edge cases, then error paths.
- **Do NOT assert on loggers.** No expectations on `logger.info` / `logger.warn` / `logger.error`
  calls — logging is not behaviour under test.

## Types

- **No `any` and no `unknown`** — and no casting counterparts (`as any`, `as unknown`). Use precise
  types for mocks, fixtures, and assertions.
- **Do not define interfaces or classes inside the test file.** Import the types from the source
  file instead.
- **Do not declare types for mock-data variables.** In a test case, apply `as <Type>` directly to the
  literal when a concrete type exists; if no type is present, use the value as-is without annotating.

```typescript
// ✅ Import the type and cast the literal directly in the test
import { Workflow } from '../entity/Workflow';

const mockWorkflow = { id: 'WF-test-001', status: WorkflowStatus.ACTIVE } as Workflow;

// ❌ Wrong — annotating the variable, or defining a type in the test file
interface LocalWorkflow { id: string } // no local types in tests
const mockWorkflow: Workflow = { ... };
const data = { ... } as any;
```

## Test data / fixtures

- **Constants and mock data live in a separate `*.json` file**, not inline in the test body. Load
  the fixture into the test and cast it to the imported type where needed.
- Keep the test file free of large inline object literals.

```typescript
import workflowFixture from './WorkflowService.test.json';

const mockWorkflow = workflowFixture.activeWorkflow as Workflow;
```

## Structure & naming

- **Do not define new functions inside the test file.** Keep the test body declarative — no local
  helper/factory functions.
- **Keep common setup in `beforeEach`** — construct the SUT, register spies, and load shared fixtures
  there so individual tests stay focused.
- **Do not use `console.log`.** A logger is allowed for diagnostics, but never inside an `expect(...)`
  statement.
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

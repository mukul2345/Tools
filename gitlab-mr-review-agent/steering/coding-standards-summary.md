# Coding Standards Quick Reference

This is the condensed reference used during MR review. Full guidelines live in `.kiro/steering/coding-guideline.md`.

---

## Naming

| Element | Rule | Bad → Good |
|---|---|---|
| Class | PascalCase noun, intention-revealing | `ReportHelper` → `ReportDataAssembler` |
| Interface | PascalCase, **no `I` prefix** (unless established pattern) | `IValidator` → `Validator<T>` |
| Abstract Class | PascalCase with `Abstract` / `Base` prefix | `TaskProcessor` → `BaseDFGTaskHandler` |
| Method | camelCase verb phrase | `processNewConfig` → `applyStructuredAttachmentConfig` |
| Boolean | `is`/`has`/`should`/`can` prefix | `force` → `allowCancelledClaimUpdate` |
| Boolean | No negation in name | `isClaimNotForExternalVendor` → `hasExternalVendorDelegation` |
| Constant | SCREAMING_SNAKE_CASE | `maxRetries` → `MAX_RETRIES` |
| Enum | PascalCase name, SCREAMING_SNAKE_CASE members | `workflowException` → `WorkFlowExceptionCodes.WORKFLOW_EXCEPTION` |
| File | PascalCase matching primary export | `workflowservice.ts` → `WorkflowService.ts` |
| Test File | `<SourceFileName>.test.ts` | `workflowTests.ts` → `WorkflowService.test.ts` |
| Type alias | PascalCase, `Type` suffix when clarity needed | `stringMap` → `StringKeyAnyValueType` |
| Parameter | No type suffix | `paymentContractObj` → `paymentContract` |
| Class suffix | No `Helper`, `Utils`, `Manager` as dump | `IARequirementsHelper` with 13 methods → split into focused classes |

**Domain Language (Ubiquitous Language):** Always use team terms — `Workflow`, `Stage`, `State`, `Run`, `Task`, `IssuingAuthority`, `VerificationRequest`, `ClaimVerification`, `Insufficiency`, `Dependency`, `Resolution`. Do not invent synonyms.

**No vague names:** `data`, `info`, `result`, `temp`, `process`, `handle` are not acceptable in production code.

---

## Functions

| Rule | Threshold | Action |
|---|---|---|
| Size | > 30 lines → review; > 50 lines → must extract | Split into named helpers |
| Nesting depth | > 2 levels | Extract to named method |
| Arguments | > 3 | Use options/parameter object |
| Side effects in getters | Any | Violates CQS — remove side effect |
| Empty `if` branch | Any | Remove the branch entirely |
| Boolean parameter | Any | Use separate methods or options object |

**SLAP:** One function = one level of abstraction. Never mix orchestration with low-level array manipulation.

**CQS:** `get*`, `fetch*`, `is*`, `has*` must never write to DB, call external services, or mutate state.

**Fail Fast / Guard Clauses:** Validate inputs at the very top of a function. Throw immediately before any expensive DB or network operation. Prefer guard clauses over nested `if` blocks.

---

## Classes

| Rule | Target |
|---|---|
| Lines | ≤ 300. > 500 = must decompose |
| Dependencies | ≤ 5–7 injected |
| Responsibility | One axis of change (SRP) |
| Cohesion | If a subset of methods only uses a subset of fields → extract a new class |
| Access modifiers | Explicit on every member (`public`, `private`, `protected`) |
| Injected deps | `private readonly` |
| Member order | Properties/deps → Constructor → Public methods → `/// PRIVATE METHODS` → Private impl |
| State | No request-scoped instance variables (stateless design) |
| Constructor | Side-effect free — no network calls, DB reads, or `process.env` access |

**Composition over Inheritance:** Use inheritance strictly for `is-a` relationships. For behavior sharing, inject as a dependency. Deep inheritance trees (Yo-Yo problem) = fragile base class risk.

**Factory Pattern:** Avoid `new ConcreteClass()` in business logic — it creates tight coupling and makes unit testing nearly impossible. Use domain factories (`TaskHandlerFactory`, `DataAccessFactory`). For new classes: Constructor Injection only. `InstanceFactory`/`setInstanceFactory` is **legacy-only**.

---

## Architecture Layers

```
Controller → Service → [Handler/Validator] → Accessor/Client → Database/Cloud
```

| Layer | Owns | Must NOT |
|---|---|---|
| Controller | HTTP I/O, request parsing, response formatting | Business logic, DB calls |
| Service | Business logic, orchestration | Raw DB queries, HTTP concerns |
| Accessor | DB queries, DynamoDB operations | Business rules |
| Handler/Strategy | Task-specific workflow logic | HTTP, direct DB writes |
| Client | External service communication | Business rules |

Dependencies flow **strictly top-down**. Lower layers never import higher layers. No circular dependencies.

**Module Structure:** Every domain module must have: `*Controller.ts`, `*Service.ts`, `*Accessor.ts`, `*Utils.ts`, `*Constants.ts`, `Entity/`, `Tests/`.

---

## TypeScript

```typescript
// ✅ Use Optional Chaining and Nullish Coalescing
const name = user?.profile?.name ?? 'Unknown';

// ❌ Non-null assertion — a lie to the compiler
const name = user!.profile!.name;

// ✅ Immutable by default
private readonly items: ReadonlyArray<ClaimItem>;

// ❌ any without justification
function process(data: any): any { ... }
```

- **No `any` types** without a justification comment
- **No `!` non-null assertion operator** — use `?.` and `??` instead
- **Immutability:** `readonly` for class properties; `ReadonlyArray<T>` for array members not intended to be mutated
- **`prefer-const`:** Use `const` when a variable is never reassigned
- **Google TypeScript Style Guide** applies

---

## Error Handling

```typescript
// ✅ Domain exception with enum code and cause chain
throw new WorkflowStageException({
  code: WorkflowStageExceptionCodes.VALIDATION_FAILED,
  message: 'Validation failed for workflow',
  cause: originalError  // always preserve cause
});

// ❌ Raw Error
throw new Error('Something went wrong');

// ❌ Empty catch
try { ... } catch (e) { /* nothing */ }

// ❌ Useless rethrow
try { ... } catch (e) { throw e; }
```

- Exception codes from enums — never raw strings
- Log before throwing at controller/service boundaries
- Retryable (transient DB/network) vs non-retryable (validation/business rule) must be correctly typed
- Catch at the right level: Controllers → HTTP responses; Services → business recovery; Handlers → workflow state management
- **`this.name` in custom exceptions must exactly match the class name** for accurate stack traces
- Custom exceptions use destructured options constructor: `constructor({ code, message, cause }: { code: string; message?: string; cause?: Error })`

---

## Comments & Documentation

```typescript
// ✅ JSDoc for public APIs
/** Creates a new workflow and triggers SLA computation */
public async createWorkflow(input: WorkflowInput): Promise<Workflow> { ... }

// ✅ Why, not What — for non-obvious business logic
// VR is cancelled — do not proceed with allocation (DMW-1234)
if (vr.status === VRStatus.CANCELLED) return;

// ✅ TODO with ticket reference
// TODO(DMW-5678): Remove after migration to new schema

// ❌ Obvious comment
// Set workflow status to ACTIVE
workflow.status = WorkflowStatus.ACTIVE;

// ❌ Journal comment — use git log
// 2026-01-15 - Added by Ravi - support for new workflow type

// ❌ Commented-out code — use version control
// const oldLogic = doOldThing();
```

- **JSDoc required** on all exported functions, classes, and factory methods
- Comment explains **why**, not **what** — if the code needs explaining, refactor the code
- **No commented-out code** — use git history
- **No journal/changelog comments** — use git log
- TODO/FIXME must include a ticket reference

---

## Logging

```typescript
// ✅ Short static message, context in metadata
logger.info('WorkflowEnqueuer: optimistic lock error while enqueuing.', {
  workflowId: workflow?.id,
  error: error instanceof Error ? error.stack : error,
});

// ❌ Long interpolated string
logger.warn(`WorkflowEnqueuer: error while enqueuing workflow ${workflow.id} due to optimistic lock`);

// ❌ Class/method in message (redundant)
logger.error('Error in ClaimItemService.getContractById', { class: ..., method: ... });
```

| Level | When |
|---|---|
| `logger.error` | Unrecoverable failures, DB failures, external service 5xx |
| `logger.warn` | Recoverable anomalies, fallbacks, retry triggered |
| `logger.info` | Key business events: workflow created, stage changed, task allocated |
| `logger.debug` | Dev/staging diagnostic detail only |

- Required context fields: `workflowId`, `requestId`, `stage`, `state`, `subType`
- Never log PII (names, emails, phone numbers, document content)
- Use `error.stack`, not just `error.message`
- Log at entry and exit of critical service methods
- Critical failures must include `alert: true` in metadata for alerting pipelines

---

## Async

```typescript
// ✅ Parallel independent calls
const [vr, ia] = await Promise.all([
  this.getVerificationRequest(vrId),
  this.getIssuingAuthority(iaId),
]);

// ❌ Sequential when parallel is possible
const vr = await this.getVerificationRequest(vrId);
const ia = await this.getIssuingAuthority(iaId);

// ✅ Fire-and-forget with explicit void + comment
void this.publishEvent({ ... }); // Non-critical telemetry

// ❌ Floating promise
this.publishEvent({ ... }); // No await, no void
```

Never mix `.then()/.catch()` with `async/await` in the same function.

---

## API Design

| Rule | Bad | Good |
|---|---|---|
| No verbs in path | `PUT /update-payment-contracts` | `PUT /payment-contracts` |
| HTTP verb matches intent | `GET /cancel-order/:id` | `POST /orders/:id/cancellation` |
| State transitions | `PATCH /verify-claim/:id` | `POST /:id/verify` |
| kebab-case URLs | `/invoiceData` | `/invoice-data` |
| Resource ID in path | `PATCH /replace-office?claimItemId=x` | `PATCH /claim-items/:id/office` |
| One route, one handler | `/appeal/:id` → same handler as `/:id` | Separate handlers |
| One controller, one resource | Controller with routes across 8 domains | Split into focused controllers |

Path parameters identify **which** resource. Query parameters control **how** to fetch (filters, sorting, pagination).

---

## Performance Red Flags

```typescript
// ❌ O(N²) — find inside map
users.map((u) => profiles.find((p) => p.userId === u.id));

// ✅ O(N+M) — Map lookup
const profileMap = new Map(profiles.map((p) => [p.userId, p]));
users.map((u) => ({ ...u, ...profileMap.get(u.id) }));

// ❌ N+1 — await inside loop
for (const id of ids) {
  await dynamoClient.getItem(id);
}

// ✅ Batch
await dynamoClient.batchGetItems(ids);
```

---

## AWS & Infrastructure

**DynamoDB:**
- Always go through `DataAccessFactory` and abstract `*Accessor` classes — never `DynamoClient` directly in service/handler code
- Handle `OptimisticLockException` for optimistic locking
- Use batch operations (`BatchGetItem`, `BatchWriteItem`) for multiple items

**SQS / SNS:**
- Producers and Consumers must extend from base classes
- Message schemas must be typed — no raw string parsing
- Always handle message visibility timeout appropriately
- **DLQ consumer must exist for every queue**

**External Service Clients:**
- All external calls go through `*ServiceClient` classes
- Wrap all HTTP errors in domain-specific exceptions
- Implement retry logic for transient failures
- Log request/response at appropriate levels

---

## Formatting & File Organisation

**File length:** 300 lines → warning (consider splitting); 500 lines → must split.

**Import order** (separated by blank lines):
```typescript
// 1. Node built-ins
import path from 'path';

// 2. External packages (npm)
import express from 'express';
import { DFGError } from '@dfg/be-stdlib';

// 3. Internal shared libraries
import { Workflow } from '@dfg/verification-workflow-engine-entity';

// 4. Internal modules (absolute paths from baseUrl)
import { WorkflowService } from '../../modules/workflow/WorkflowService';

// 5. Relative imports (same module)
import { AllocationConfigs } from './AllocationConfigs';
```

**Tooling (non-negotiable):** Prettier (4-space indent, single quotes, trailing commas), ESLint (strict TS rules), Husky (pre-commit hooks), SonarQube (quality gate).

---

## Testing

**Coverage targets:**

| Metric | Minimum | Target |
|---|---|---|
| Line coverage | 80% | 90%+ |
| Branch coverage | 75% | 85%+ |
| New code | 90% | 95%+ |

**Structure:** AAA (Arrange-Act-Assert). Group: happy path → edge cases → error cases.

**Naming:** `it('should <expected behavior> when <condition/scenario>')`

**Mocking:**
- Mock at boundaries only (external services, DB, AWS SDKs)
- Use `jest.spyOn` for service method mocks
- Never mock what we own — if a utility needs mocking, it probably needs a better interface
- `afterEach(() => jest.clearAllMocks())`

**Test data:**
- Complex fixtures → `.test.json` files alongside tests
- Simple objects → factory functions: `createMockWorkflow(overrides: Partial<Workflow> = {})`

---

## Environment & Configuration

- **No hardcoded config:** No ARNs, DynamoDB table names, SQS URLs, or API endpoints as string literals
- Centralise all config: avoid scattering `process.env` calls — use a single `Config` object or `Constants` file
- **Fail fast on boot:** Validate all required environment variables at startup. A service that fails to start is safer than one that crashes mid-execution with a missing `API_KEY`

---

## Git & Version Control

- **Atomic commits:** One logical task per commit. No mixing feature logic with linting or reformatting changes
- **Conventional commit format (imperative mood):** `feat: add validation to workflow`, `fix: handle null claimId in processor`, `refactor: extract payment handler from service`
- **Clean history:** Squash WIP commits before merging. The git log should read like well-structured prose

---

## PSV / DSV Rule

Whenever code branches on `ComponentTypeEnum.PSV`, ask:

> **Does this logic also need to apply to `ComponentTypeEnum.DSV`?**

If yes → update the condition to cover both. If no → add a comment explaining why PSV only.

---

## Top Anti-Patterns to Flag in Review

| Anti-Pattern | Signal |
|---|---|
| God Class | Service > 500 lines, > 7 dependencies |
| Helper/Utils class | Unbounded suffix, grows without limit |
| `eslint-disable` | Without justification comment |
| Stringly-typed code | Raw string where enum should be used |
| Deep nesting > 3 levels | Extract to named helper |
| Boolean parameters | Use options object |
| Shotgun surgery | One change touches 10+ files |
| Context leaking | Request data stored in class instance vars |
| Pass-through service layer | Service only catches and rethrows |
| `get*` with side effects | Fetch that writes to DB or calls external service |
| Yo-Yo Problem | Deep inheritance making code flow impossible to follow |
| Feature Envy | Method uses another class's data more than its own — move it |
| Primitive Obsession | Passing raw `string` for `workflowId`, `entityId` — consider value objects |
| Flat utils dumping ground | `utils/` folder with 30+ unrelated single-method files |
| Combinatorial class explosion | 12 near-identical classes for 3 boolean/enum combinations — use parameters |
| Copy-paste across siblings | Same private method verbatim in 5+ classes — extract to shared base/utility |
| Non-null assertion (`!`) | Lie to the compiler — causes runtime crashes |
| `any` type | Escape hatch from type safety — always justify |
| Hardcoded config | ARNs, table names, endpoints as string literals |
| No DLQ consumer | SQS queue without a dead-letter queue consumer |

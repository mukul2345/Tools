---
inclusion: fileMatch
fileMatchPattern: "**/*.ts"
---

# Clean Code Guidelines

## 1. Philosophy & Guiding Principles

> *"Clean code reads like well-written prose."* — Robert C. Martin

### The Boy Scout Rule

Always leave the code cleaner than we found it. If we touch a file, improve it — rename an unclear variable, extract a helper, add a missing type.

### SOLID

| Principle | The "Clean Code" Meaning | The Practical Goal |
| --- | --- | --- |
| Single Responsibility (SRP) | Each module should have one reason to change. | Avoid "God Objects" that do everything. |
| Open/Closed (OCP) | We should be able to add new features without editing old code. | Prevent "ripple effect" bugs in stable code. |
| Liskov Substitution (LSP) | Subtypes must be completely substitutable for their base types. | Ensure our abstractions don't "break" the app. |
| Interface Segregation (ISP) | Clients shouldn't be forced to depend on methods they don't use. | Keep interfaces lean and specific. |
| Dependency Inversion (DIP) | High-level logic shouldn't depend on low-level details. | Decouple our business logic from the Database/UI. |

### YAGNI & DRY

**YAGNI (You Ain't Gonna Need It):** This principle is a core tenet of Extreme Programming (XP). It's the defense against "Over-Engineering."

- **The "Smell":** Adding a feature or a layer of abstraction because we think we might need it "down the road" or for "future scalability."
- **The Reality:** We are terrible at predicting the future. Usually, that "future" requirement never arrives, or it arrives in a form we didn't anticipate, making our preemptive code a burden.
- **The Rule:** Do not write code for a requirement that does not exist today. Implement things only when we actually need them.

**DRY:** The core idea is that every piece of knowledge or logic must have a single, unambiguous representation within a system.

- **The "Smell":** If we find ourselves copy-pasting a block of code and changing one variable, we've failed the DRY test.
- **The Solution:** Extract the common logic into a separate method, class, or module.
- **The Benefit:** When requirements change, we only have to fix the logic in one place. If we have "accidental duplication," we'll eventually update one instance and forget the others, creating bugs.

---

## 2. Naming Conventions

> *"The name of a variable, function, or class should answer all the big questions."* — Clean Code, Ch. 2

### 2.1 Our Philosophy on Naming

We treat naming as the primary way we tell the "story" of our code to our fellow developers. Before committing any name, we must ask ourselves:

- **Is this name justified?** Does it accurately represent the data it holds or the action it performs?
- **Does it provide context?** If a teammate reads this name in isolation, will they understand its purpose without jumping to the definition?
- **Is it part of the story?** Does this name help the overall logic read like well-written prose?

**Don't Do Injustice to the Name.** We recognize that finding the "perfect" name is often the hardest part of programming. If we are struggling to name a concept, we do not settle for generic terms like `data`, `info`, `manager`, `processor`, `process`, or `helper`.

Instead, we leverage our tools — we discuss the context with AI assistants (Gemini, Cursor, etc.) to brainstorm a precise name. If we cannot name a class clearly, it is often a sign that the class is trying to do too much and needs to be split.

### 2.2 General Rules

| Element | Convention | Example |
| --- | --- | --- |
| Classes | PascalCase, noun | `AllocationService`, `WorkflowController` |
| Interfaces | PascalCase, no `I` prefix (unless established pattern) | `Validator<T>`, `InstanceFactory` |
| Abstract Classes | PascalCase with `Abstract`/`Base` prefix | `BaseDFGTaskHandler`, `AbstractBaseDataAccessor` |
| Methods / Functions | camelCase, verb phrase | `createWorkflow()`, `getVerifierDetails()` |
| Boolean variables | `is`, `has`, `should`, `can` prefix | `isTaskClosable`, `hasError` |
| Constants | SCREAMING_SNAKE_CASE | `REASSIGN_BATCH_SIZE`, `SERVICE_NAME` |
| Enums | PascalCase name, SCREAMING_SNAKE_CASE members | `WorkFlowExceptionCodes.WORKFLOW_EXCEPTION` |
| Files | PascalCase matching the primary export | `WorkflowService.ts`, `IACreationTaskHandler.ts` |
| Test Files | `<SourceFileName>.test.ts` | `AllocationController.test.ts` |
| Type aliases | PascalCase with `Type` suffix when clarity is needed | `StringKeyAnyValueType`, `OpsUserAttributeType` |

### 2.3 Domain-Specific Naming

Use the team's ubiquitous language consistently:

- Workflow, Stage, State, Run, Task
- IssuingAuthority
- VerificationRequest, ClaimVerification
- Insufficiency, Dependency, Resolution

---

## 3. Functions & Methods

> *"The first rule of functions is that they should be small. The second rule is that they should be smaller than that."* — Clean Code, Ch. 3

### 3.1 Size & Scope

- **Target:** ≤ 20–30 lines per function. If a function exceeds 50 lines, it almost certainly needs extraction.
- **Indentation depth:** Maximum 2 levels of nesting. Extract helper methods for deeper logic.

### 3.2 Function Arguments

- **Ideal:** 0–2 arguments (niladic / monadic / dyadic)
- **Maximum:** 3 arguments. Beyond 3, use an options object / parameter object.

### 3.3 Single Level of Abstraction (SLAP)

Each function should operate at one level of abstraction. Don't mix high-level orchestration with low-level details.

### 3.4 Command-Query Separation

Functions should either do something (command) or return something (query), never both.

### 3.5 No Side Effects

If a function is named `getX()`, it must not secretly modify state, send notifications, or write to the database.

---

## 4. Classes & Object-Oriented Design

> *"Classes should be small... measured in responsibilities."* — Clean Code, Ch. 10

### 4.1 Single Responsibility Principle

Each class should have one axis of change. Watch for the following layer violations:

| Class | Should Handle | Should NOT Handle |
| --- | --- | --- |
| `*Controller` | HTTP I/O, request parsing, response formatting | Business logic, DB calls |
| `*Service` | Business logic, orchestration | Direct HTTP concerns, raw DB queries |
| `*Accessor` / `*DynamoAccessor` | Data persistence, query construction | Business rules |
| `*TaskHandler` | Workflow task execution logic | HTTP, direct DB writes |
| `*Validator` | Input/state validation | Business execution |
| `*Client` | External service communication | Business rules |

### 4.2 Class Size Guidelines

- **Target:** ≤ 200–300 lines. Services above 500 lines need decomposition.
- **Maximum dependencies:** A class with more than 5–7 injected/instantiated dependencies is doing too much. Split it.

### 4.3 Cohesion

All methods in a class should operate on the class's core data/responsibility. If a subset of methods only uses a subset of fields, consider extracting a new class.

### 4.4 Prefer Composition over Inheritance

Inheritance should be used strictly for "is-a" relationships (e.g., `WorkflowRetryableException` is a `WorkFlowException`). For behavior sharing, use composition.

- **The Problem:** Deep inheritance trees create "Fragile Base Classes." A change in the parent can unexpectedly break dozens of descendants.
- **The Rule:** If we want to reuse logic from another class, inject it as a dependency rather than extending it.
- **The Benefit:** Composition allows us to swap behaviors at runtime (Strategy Pattern) and makes unit testing easier by mocking small, injected components.

```typescript
// ❌ BAD: Hard-to-test inheritance
class PdfInvoiceService extends BaseBlobStorageService { 
    // Inherits 50 methods it doesn't need just to use 'upload()'
}

// ✅ GOOD: Clean composition
class PdfInvoiceService {
    constructor(private readonly storageClient: BlobStorageClient) {}
    
    async generate(data: InvoiceData) {
        const pdf = await this.render(data);
        await this.storageClient.upload(pdf); // Uses only what it needs
    }
}
```

### 4.5 Factory Pattern & Dependency Instantiation

Avoid scattering `new ConcreteClass()` calls across business logic. This creates tight coupling and makes unit testing (mocking) nearly impossible.

**Primary Rule: Use Domain Factories**

Use specialized factories (e.g., `TaskHandlerFactory`, `DataAccessFactory`) to resolve implementation details based on runtime subtypes.

```typescript
// ❌ BAD: Direct instantiation in business logic
const handler = new IACreationTaskHandler(context);

// ✅ GOOD: Use factory to resolve the correct handler
const handler = await TaskHandlerFactory.getDependencyTaskHandlerAsync(subType, context);
```

**Legacy Support: InstanceFactory**

The `InstanceFactory` pattern was introduced specifically to decouple legacy classes where the `new` keyword was heavily hard-coded and refactoring posed a high regression risk.

- **For Legacy Code:** We may use the `setInstanceFactory` pattern to enable mocking in existing tests.
- **For New Classes:** DO NOT use `InstanceFactory`. Instead, use **Constructor Injection**. Pass dependencies as interfaces in the constructor to ensure the class is inherently testable and ready for a future DI framework (like NestJS or Inversify).

```typescript
// ⚠️ LEGACY ONLY: Use only if refactoring the constructor is too risky
private instanceFactory: InstanceFactory = new SimpleInstanceFactory();

public setInstanceFactory(value: InstanceFactory) {
  this.instanceFactory = value;
}
```

```typescript
// ✅ NEW STANDARD: The Dependencies Interface

interface WorkflowServiceOptions {
  workflowAccessor?: WorkflowAccessor;
  apiClient?: ExternalServiceClient;
}

export class WorkflowService {
  private readonly workflowAccessor: WorkflowAccessor;
  private readonly apiClient: ExternalServiceClient;

  constructor(options: WorkflowServiceOptions = {}) {
    this.workflowAccessor = options.workflowAccessor ?? DataAccessFactory.getWorkflowAccessor();
    this.apiClient = options.apiClient ?? new ExternalServiceClient();
  }
}
```

**The Rule:** Methods should receive their dependencies via the constructor, never by fetching them from a Global/Singleton inside the method body.

### 4.6 Prefer Stateless over Stateful Design

Aim for "Shared Nothing" within our service instances. Classes should behave like pipes, not like buckets.

- **The Goal:** A class instance should be able to handle Request A and Request B concurrently without any risk of data bleeding between them.
- **The Rule:** Avoid "Instance Variables" (class properties) that store data related to a specific execution or request.
  - **Allowed:** Injected dependencies (Services, Accessors, Configs).
  - **Forbidden:** Request-specific data (User IDs, current Workflow objects, temporary counters).
- **The Benefit:** Stateless classes are inherently thread-safe, easier to cache, and significantly simpler to test because we don't have to "reset" the object state between tests.

| Feature | Stateless (Preferred) | Stateful (Avoid) |
| --- | --- | --- |
| Data Storage | Passed via method arguments | Stored in `this.variable` |
| Concurrency | Safe for parallel execution | Risk of race conditions |
| Lifecycle | Usually Singleton/Long-lived | Often Request-scoped |

### 4.7 Explicit Access Modifiers
In TypeScript, members are public by default. However, we do not rely on implicit behavior. We make the accessibility of every class member explicit to improve readability and intent.

The Rule: Every property and method must have an explicit access modifier: public, protected, or private.

The Goal: We want a developer to know exactly how a method is intended to be used without having to guess if the author "forgot" to mark it as private.

Property Standard: We prioritize private readonly for our injected dependencies to enforce immutability and encapsulation.

```
// ❌ BAD: Implicitly public
class WorkflowService {
  workflowAccessor: WorkflowAccessor;

  process(id: string) { 
    this.internalStep(id);
  }

  internalStep(id: string) { /* ... */ }
}

// ✅ GOOD: Explicit intent
export class WorkflowService {
  private readonly workflowAccessor: WorkflowAccessor;

  public async process(id: string): Promise<void> { 
    await this.internalStep(id);
  }

  private async internalStep(id: string): Promise<void> { /* ... */ }
}
```

### 4.8 Class Member Organization & Scannability

We organize our classes so that the most important information — the public interface — is found first. We treat our classes like a newspaper article: the headline (Public API) comes first, followed by the details (Private Implementation).

**The Rule:** All public methods must be grouped at the top of the class. All private and protected methods must be moved to the bottom.

**The Separator:** We use a clear visual separator (a comment line or a fold) to indicate where the public interface ends and the internal implementation begins.

**The Benefit:** This allows a fellow developer to understand the "Contract" of the class without having to scroll through hundreds of lines of private helper logic.

```typescript
export class WorkflowService {
    // 1. Properties / Dependencies
    private readonly workflowAccessor: WorkflowAccessor;

    // 2. Constructor
    constructor(options: WorkflowServiceOptions = {}) {
        this.workflowAccessor = options.workflowAccessor ?? DataAccessFactory.getWorkflowAccessor();
    }

    // 3. Public Methods (The "What")
    public async processWorkflow(id: string): Promise<void> {
        const data = await this.workflowAccessor.getById(id);
        await this.internalValidation(data);
    }

    /// PRIVATE METHODS

    private async internalValidation(data: Workflow): Promise<void> {
        if (!data) throw new WorkflowException('No data found');
        // ... logic
    }
}
```
---

## 5. Architecture & Layering

### 5.1 Layered Architecture

```
┌─────────────────────────────────────────┐
│             Controller Layer             │  HTTP handling, route definitions,
│     (extends BaseController)             │  request/response transformation
├─────────────────────────────────────────┤
│              Service Layer               │  Business logic, orchestration,
│     (*Service classes)                   │  workflow processing
├─────────────────────────────────────────┤
│          Handler / Strategy Layer        │  Task-specific logic
│  (BaseDFGTaskHandler, StateHandler,      │
│   StageHandler, Rules, Predicates)       │
├─────────────────────────────────────────┤
│           Validator Layer                │  Pre-handle & state validation
│     (implements Validator<T>)            │
├─────────────────────────────────────────┤
│        Data Access / Accessor Layer      │  Database operations (DynamoDB),
│  (Abstract Accessor → DDbImpl)           │  query building
├─────────────────────────────────────────┤
│      Client Layer (External Services)    │  HTTP calls to IA, VR, Ops, Payment
│     (*ServiceClient classes)             │  services
├─────────────────────────────────────────┤
│           PubSub Layer                   │  SQS Producers, Consumers,
│  (Producer, Consumer, PubSub)            │  Message processing
├─────────────────────────────────────────┤
│        Exception Layer                   │  Domain-specific exception hierarchy
│  (WorkFlowException → specific errors)  │
└─────────────────────────────────────────┘
```

### 5.2 Dependency Flow (Strict Top → Down)

**Flow:** Request → Controller → Service → [Handler/Validator] → Accessor/Client → Database/Cloud

> Dependencies ONLY point downward. Lower layers NEVER import higher layers.

**Rules:**

- Controllers never call Accessors or Clients directly
- Handlers never import Controllers
- Accessors never import Services
- No circular dependencies between modules

### 5.3 Module Structure

Each domain module must follow this structure:

```
modules/
└── <moduleName>/
    ├── <ModuleName>Controller.ts      # Route definitions & HTTP I/O
    ├── <ModuleName>Service.ts         # Business logic
    ├── <ModuleName>Accessor.ts        # Abstract data access interface
    ├── <ModuleName>Utils.ts           # Pure utility functions (stateless)
    ├── <ModuleName>Constants.ts       # Module-specific constants
    ├── Entity/                        # Domain models / DTOs
    │   └── <EntityName>.ts
    └── Tests/
        ├── <ModuleName>Controller.test.ts
        ├── <ModuleName>Service.test.ts
        └── <testdata>.test.json       # Test fixtures (JSON)
```

---

## 6. Error Handling & Exceptions

> *"Error handling is important, but if it obscures logic, it's wrong."* — Clean Code, Ch. 7

### 6.1 Exception Hierarchy

Follow the established exception class hierarchy:

```
DFGError (from @dfg/be-stdlib)
  └── WorkFlowException
        ├── WorkflowProcessorException
        ├── WorkflowRetryableException
        ├── WorkflowSQSException
        ├── WorkflowAllocationException
        ├── SlaException
        ├── *StageException (per handler/stage)
        └── *RuleException (per rule)
  └── DynamoApiException (for data layer errors)
```

### 6.2 Rules for Exception Usage

Prefer creating custom exceptions over `DFGError`.

```typescript
// ✅ Acceptable: Domain-specific exception with error code enum
throw new VRValidationStageException(
  VRValidationStageExceptionCodes.VALIDATION_FAILED,
  `Validation failed for workflow ${workflowId}`,
  originalError
);

// ❌ BAD: Generic error with string message
throw new Error('Something went wrong');

// ❌ BAD: Swallowing exceptions silently
try { ... } catch (e) { /* nothing */ }

// ❌ BAD: Useless catch and rethrow
try {
  await someOperation();
} catch (e) {
  throw e;  // This adds no value
}
```

### 6.3 Exception Handling Rules

**Catch at the right level:** Controllers catch and translate to HTTP responses. Services catch for business recovery. Handlers catch for workflow state management.

**Always preserve the cause chain:**

```typescript
// ✅ Acceptable
throw new IACreationException(
  IACreationExceptionCodes.IA_CREATION_FAILED,
  'Failed to create IA office',
  originalError  // preserve cause
);
```

**Use error codes from enums — never use raw strings:**

```typescript
// ✅ Acceptable
export enum IACreationExceptionCodes {
  IA_CREATION_FAILED = 'IA_CREATION_FAILED',
  IA_OFFICE_NOT_FOUND = 'IA_OFFICE_NOT_FOUND',
}
```

**Log before throwing at boundaries:**

```typescript
// ✅ Acceptable: Controller-level error handling pattern
try {
  const result = await this.workflowService.processWorkflow(id);
  return res.status(200).send(new DFGResponse(requestID, [result], new Pagination()));
} catch (error) {
  logger.error('Error processing workflow', {
    workflowId: id,
    error: error instanceof Error ? error.stack : error,
  });
  const { statusCode, response } = this.prepareFinalErrorResponse(requestID, error);
  return res.status(statusCode).send(response);
}
```

**Differentiate retryable vs non-retryable exceptions:**

```typescript
// ✅ Retryable: External service timeouts, transient DynamoDB errors
throw new WorkflowRetryableException(
  WorkflowRetryableExceptionCodes.TRANSIENT_ERROR,
  'DynamoDB throttled, safe to retry'
);

// ✅ Non-retryable: Validation failures, business rule violations
throw new VRValidationStageException(
  VRValidationStageExceptionCodes.INVALID_STATE,
  'Workflow is in terminal state, cannot process'
);
```

### 6.4 Builder Pattern for Exceptions

Prefer the builder pattern for complex exceptions (only complex exceptions):

```typescript
// ✅ Acceptable
return DynamoApiException.builder()
            .withResourceName(resourceName)
            .withResourceOperation(resourceOperation)
            .withCode(code)
            .withRootCauseError(error)
            .build();
```

---

## 7. TypeScript-Specific Guidelines

We shall strictly adhere to the [Google TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html).

---

## 8. Comments & Documentation

> *"Comments are failure to express yourself in code. Every time you write a comment, you should grimace and feel a sense of failure."* — Clean Code

**"Comments Lie"** — Code changes and evolves, but comments rarely do. Over time, a comment that was once helpful becomes a "lie" — misleading developers about what the code actually does.

> *"The older a comment is, and the farther away it is from the code it describes, the more likely it is to be simply wrong."*

**Code Should Explain Itself** — If our code is so complex that it needs a comment, the code is the problem. Instead of writing a comment, we should refactor the code.

### 8.1 When to Comment

| Comment Type | When | Example |
| --- | --- | --- |
| JSDoc on public APIs | Always for exported functions/classes | `/** Creates a workflow and triggers SLA computation */` |
| Why, not What | When business context is non-obvious | `// VR is cancelled, so we should not proceed (DMW-1234)` |
| TODO/FIXME | With ticket reference | `// TODO(DMW-5678): Remove after migration` |
| Regulatory/Legal | Domain constraints | `// GDPR: PII must not be logged` |

### 8.2 When NOT to Comment

```typescript
// ❌ BAD: Obvious, adds no value
// Set workflow status to ACTIVE
workflow.status = WorkflowStatus.ACTIVE;

// ❌ BAD: Journal comment (use git log instead)
// 2026-01-15 - Added by Abhishek - Support for new workflow type

// ❌ BAD: Commented-out code (use version control)
// const oldLogic = doOldThing();

// ❌ BAD: Closing brace comment
} // end if
} // end for
```

### 8.3 JSDoc for Public Interfaces

Use JSDoc for factories, interfaces, and public service methods:

```typescript
/**
 * Creates a new instance of the specified type.
 * @template T The type of instance to be created
 * @param constructor The constructor function of the class to instantiate
 * @param args Arguments to pass to the constructor
 * @returns A new instance of type T
 */
create<T>(constructor: new (...args: any[]) => T, ...args: any[]): T;
```

---

## 9. Testing Standards

> *"Test code is just as important as production code."* — Clean Code, Ch. 9

### 9.1 Test Structure: AAA Pattern (Arrange-Act-Assert)

```typescript
describe('AllocationService', () => {
  describe('allocateTask', () => {
    it('should assign workflow to ops user when user has capacity', async () => {
      // Arrange
      const workflow = createMockWorkflow({ status: WorkflowStatus.ACTIVE });
      const opsUser = createMockOpsUser({ availableSlots: 5 });
      mockGetWorkflowById.mockResolvedValue(workflow);

      // Act
      const result = await allocationService.allocateTask(opsUser.id, workflow.id);

      // Assert
      expect(result.assignedTo).toBe(opsUser.id);
      expect(result.status).toBe(WorkflowStatus.ACTIVE);
      expect(mockUpdateWorkflow).toHaveBeenCalledTimes(1);
    });
  });
});
```

### 9.2 Test Naming Convention

```typescript
it('should <expected behavior> when <condition/scenario>')

// ✅ GOOD
it('should throw WorkflowRetryableException when DynamoDB is throttled')
it('should return empty array when no workflows match filter criteria')
it('should mark task as closable when all dependencies are resolved')

// ❌ BAD
it('test1')
it('works correctly')
it('allocation test')
```

### 9.3 Test Organization

```typescript
describe('WorkflowService', () => {
  // Setup
  beforeEach(() => { /* reset mocks, load fixtures */ });
  afterEach(() => { jest.clearAllMocks(); });

  // Group by method
  describe('createWorkflow', () => {
    // Happy path first
    it('should create workflow with valid input', ...);

    // Edge cases
    it('should generate unique ID when not provided', ...);

    // Error cases last
    it('should throw when entity already exists', ...);
  });

  describe('processWorkflow', () => { ... });
});
```

### 9.4 Test Data Management

- Store complex fixtures in `.test.json` files alongside tests
- Use factory functions for simple mocks

```typescript
// ✅ Acceptable: Load from JSON for complex objects
const baseTestData = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'WorkflowService.test.json'), 'utf-8')
);

// ✅ Acceptable: Factory function for simple objects
function createMockWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: 'WF-test-001',
    status: WorkflowStatus.ACTIVE,
    stage: Stage.VALIDATION,
    state: State.IN_PROGRESS,
    ...overrides,
  };
}
```

### 9.5 Mocking Guidelines

- Mock at the boundary (external services, database, AWS SDKs)
- Use `jest.spyOn` for service method mocks
- Never mock what we own — if we need to mock a utility, it may need a better interface

```typescript
// ✅ Fine: Mock external boundary
mockGetVerificationRequestById = jest.spyOn(
  VerificationRequestServiceClient, 'getVerificationRequestById'
);
```

### 9.6 Coverage Targets

| Metric | Minimum | Target |
| --- | --- | --- |
| Line coverage | 80% | 90%+ |
| Branch coverage | 75% | 85%+ |
| New code | 90% | 95%+ |

---

## 10. Formatting & Tooling

### 10.1 Enforced by Tools (Non-Negotiable)

| Tool | Purpose | Config |
| --- | --- | --- |
| Prettier | Code formatting | `.prettierrc.json` — 4-space indent, single quotes, trailing commas |
| ESLint | Static analysis | `eslint.config.mjs` — strict TS rules |
| Husky | Pre-commit hooks | Auto-format staged files |
| SonarQube | Quality gate | `sonar-project.properties` |

### 10.2 Key ESLint Rules (Already Enforced)

- `@typescript-eslint/no-explicit-any`: error — No escape from type safety
- `@typescript-eslint/no-floating-promises`: error — All promises must be awaited or explicitly voided
- `@typescript-eslint/no-misused-promises`: error — No passing async functions where sync is expected
- `prefer-const`: error — Use `const` when variable isn't reassigned
- `no-useless-catch`: error — Don't catch-and-rethrow without adding value
- `unused-imports/no-unused-imports`: error — Keep imports clean

### 10.3 File & Import Organization

Order imports in this sequence (separated by blank lines):

```typescript
// 1. Node built-ins
import path from 'path';
import { randomUUID } from 'crypto';

// 2. External packages (npm)
import express, { Request, Response } from 'express';
import { DFGError, logger } from '@dfg/be-stdlib';

// 3. Internal shared libraries
import { Workflow, Stage, State } from '@dfg/verification-workflow-engine-entity';

// 4. Internal modules (absolute paths from baseUrl)
import { WorkflowService } from '../../modules/workflow/WorkflowService';
import { DataAccessFactory } from '../../database/DataAccessFactory';

// 5. Relative imports (same module)
import { AllocationConfigs } from './AllocationConfigs';
import { Criteria } from './Criteria';
```

### 10.4 File Length

- **Maximum:** 500 lines. Files exceeding this must be split.
- **Warning threshold:** 300 lines — consider if the file can be decomposed.

---

## 11. Async Operations & Concurrency

### 11.1 Always Await or Explicitly Void Promises

```typescript
// ❌ BAD: Floating promise (caught by ESLint)
this.publishWorkflowDebugEvent({ ruleDescription: 'test', result: true });

// ✅ GOOD: Awaited
await this.publishWorkflowDebugEvent({ ruleDescription: 'test', result: true });

// ✅ OK: Explicitly fire-and-forget (with void keyword + comment)
void this.publishWorkflowDebugEvent({  // Non-critical telemetry
  ruleDescription: 'Is task closable?',
  result: isTaskClosable,
});
```

### 11.2 Parallel Execution

Use `Promise.all` / `Promise.allSettled` when operations are independent:

```typescript
// ❌ BAD: Sequential when parallel is possible
const vr = await this.getVerificationRequest(vrId);
const ia = await this.getIssuingAuthority(iaId);
const ops = await this.getOpsUser(opsId);

// ✅ Acceptable: Parallel independent calls
const [vr, ia, ops] = await Promise.all([
  this.getVerificationRequest(vrId),
  this.getIssuingAuthority(iaId),
  this.getOpsUser(opsId),
]);
```

### 11.3 Error Handling in Async Flows

- Use `try/catch` for `async/await`
- Never mix `.then()`/`.catch()` with `async/await` in the same function

```typescript
// ❌ BAD: Mixed patterns
async function process() {
  const result = await getData();
  return processResult(result).then(r => save(r)).catch(e => handle(e));
}

// ✅ GOOD: Consistent async/await
async function process(): Promise<void> {
  const result = await getData();
  const processed = await processResult(result);
  await save(processed);
}
```

---

## 12. Logging Standards

### 12.1 Log Levels

| Level | When | Example |
| --- | --- | --- |
| `logger.error` | Unrecoverable failures, exceptions | DB failures, external service 5xx |
| `logger.warn` | Recoverable anomalies, fallbacks | Retry triggered, config missing using default |
| `logger.info` | Key business events, flow milestones | Workflow created, stage changed, task allocated |
| `logger.debug` | Diagnostic detail (dev/staging only) | Intermediate variable states, query params |

### 12.2 Structured Logging

```typescript
// ✅ Acceptable: Structured with context
logger.info('DependencyHandler doWork: START', {
  workflowId: workflow.id,
  stage: workflow.stage,
  subType: workflow.subType,
});

// ❌ BAD: class and method unnecessary
logger.error('Error in getContractById', {
    class: this.constructor.name,
    method: this.getContractById.name,
    error: error.stack,
    message: error?.message,
    contractId
});
```

### 12.3 Concise Logging

Log messages should be brief and descriptive. Avoid long, interpolated strings that trigger linter line-breaks (e.g., 120-character limits), as multi-line logs are harder to scan and can break log aggregation parsing.

**Key Principles:**

- **Keep strings static:** Avoid embedding large variables directly in the message.
- **Leverage Metadata:** Place IDs, status codes, and stack traces in the secondary attributes object.
- **Scan-ability:** Ensure the core error is visible at the start of the log entry.

```typescript
// ❌ Not Acceptable — The long string forces awkward wrapping
// and makes it harder to filter by message.
logger.warn(
    `WorkflowEnqueuer: error while enqueuing the workflow ${workflow.id} due to optimistic lock exception`, 
    {
        error: error instanceof Error ? error.stack : error,
    }
);

// ✅ Acceptable — The message is a fixed "anchor" for searches,
// while specific data is neatly encapsulated.
logger.warn('WorkflowEnqueuer: optimistic lock error while enqueuing.', {
    workflowId: workflow?.id,
    error: error instanceof Error ? error.stack : error,
});
```

### 12.4 Logging Rules

- Never log PII (Personally Identifiable Information) — names, emails, phone numbers, documents
- Always log: `workflowId`, `requestId`, `stage`, `state`, `subType` for traceability
- Log at entry and exit of critical service methods
- Use `error.stack` not just `error.message` for exceptions

---

## 13. AWS & Infrastructure Patterns

### 13.1 DynamoDB Access

- Always go through `DataAccessFactory` and abstract `*Accessor` classes
- Never use `DynamoClient` directly in service/handler code
- Handle `OptimisticLockException` for optimistic locking
- Use batch operations for multiple items

### 13.2 SQS / SNS (PubSub Layer)

- Producers and Consumers must extend from base classes
- Message schemas must be typed — no raw string parsing
- Always handle message visibility timeout appropriately
- DLQ consumer must exist for every queue

### 13.3 External Service Clients

- All external calls go through `*ServiceClient` classes
- Wrap all HTTP errors in domain-specific exceptions
- Log request/response at appropriate levels
- Implement retry logic for transient failures

---

## 14. Code Review Checklist

Every PR reviewer should verify:

**Correctness**

- [ ] Logic is correct and handles edge cases
- [ ] Error paths are tested
- [ ] Async operations are properly awaited
- [ ] No race conditions in parallel operations

**Clean Code**

- [ ] Functions are ≤ 30 lines, methods at single abstraction level
- [ ] Class has single responsibility
- [ ] No `any` types without justification
- [ ] Naming is intention-revealing
- [ ] No commented-out code

**Architecture**

- [ ] Correct layer boundaries (Controller → Service → Accessor)
- [ ] New exceptions follow hierarchy and use enum codes
- [ ] Dependencies flow top-down only

**Testing**

- [ ] Unit tests cover happy path, edge cases, and error paths
- [ ] Mocks are at boundaries, not on internal implementation
- [ ] Test names follow convention
- [ ] No test interdependencies

**Operations**

- [ ] Structured logging with context (`workflowId`, `requestId`)
- [ ] No PII in logs
- [ ] Alerts for critical failures (`alert: true`)
- [ ] Error recovery/retry strategy for retryable failures

---

## 15. Anti-Patterns to Avoid

| Anti-Pattern | Problem | Solution |
| --- | --- | --- |
| God Class | Service with 2000+ lines doing everything | Split by subdomain/responsibility |
| `eslint-disable` proliferation | Hiding problems instead of fixing them | Fix the root cause; if truly needed, add a justification comment |
| Stringly-typed code | Using raw strings for states, types, codes | Use enums: `Stage`, `State`, `WorkflowStatus` |
| Deep nesting (> 3 levels) | Hard to read and test | Extract to named helper methods |
| Boolean parameters | `process(workflow, true, false)` — unclear | Use options object or separate methods |
| Shotgun surgery | One change requires touching 10+ files | Improve cohesion, group related logic |
| Feature envy | Method uses another class's data more than its own | Move method to the class whose data it uses |
| Primitive obsession | Passing `string` for workflowId, entityId, etc. | Consider branded types or value objects |
| Test interdependency | Tests fail when run in different order | Each test must set up its own state |
| Yo-Yo Problem | Deep inheritance making it impossible to follow code flow | Flatten hierarchy; use Composition |
| Context Leaking | One request's data affecting another due to class state | Make services stateless; pass context as arguments |

---

## 16. Don't Over-Engineer

Over-engineering is the act of building more structure than the problem demands. It makes code harder to navigate, harder to change, and harder to onboard into — the very problems that "good design" was supposed to solve.

### 16.1 Recognise the Signs

| Signal | Symptom |
| --- | --- |
| Combinatorial class explosion | Creating a separate class for every combination of 2–3 boolean/enum axes, resulting in 12+ near-identical classes instead of one parameterised class |
| Copy-paste across sibling classes | The same private method appears verbatim in 5+ classes — a sign they should have been one class, or the method should live in a shared base/utility |
| One exception class per utility | 25 custom exception classes that all carry the same structure (code + message). Three or four well-named exception categories suffice for most modules |
| Pass-through service layer | Every service method is a try-catch-rethrow relay that adds zero business logic. If the service only re-wraps exceptions, the orchestrator should throw the right exception directly |
| Flat "utils" dumping ground | 30+ single-method files in a flat `utils/` folder with no cohesion or grouping |
| 15× file explosion across versions | A V2 rewrite that turns 18 files into 273 files for the same domain entity |

**The "Thin Constructor" Rule**

Constructors must be side-effect free. If our default dependency (`new DefaultClient()`) performs network calls, hits a database, or reads environment variables during instantiation, it must be injected. Do not put logic in the constructor that can fail at runtime.

### 16.2 Guidelines

- **Prefer parameters over class hierarchies.** If two classes differ only by a boolean or enum value, they should be one class with a parameter.
- **Count our files.** If a module for a single entity exceeds 30–40 files, step back and ask if the abstraction is earning its keep.
- **Limit exception granularity.** Group exceptions by category (validation, processing, data-access), not by the class that throws them.
- **Eliminate pass-through layers.** If a layer only catches and re-throws, either push the exception translation down or remove the layer.
- **One "utils" folder is a smell.** If `utils/` has more than 5–7 files, the contents deserve proper sub-modules or should be folded into the classes that use them.
- **Extract only when there's a second caller.** Don't pre-emptively create an abstraction "in case we need it later." Wait until the duplication or the second use case actually appears.

---

## 17. API Design Guidelines

### 17.1 HTTP Verbs Must Match the Operation's Semantic Intent

| Verb | Purpose | Idempotent? |
| --- | --- | --- |
| GET | Retrieve a resource or collection. Must not cause side effects. | Yes |
| POST | Create a new resource, or trigger a one-off action/command. | No |
| PUT | Full replacement of an existing resource. | Yes |
| PATCH | Partial update of specific fields on an existing resource. | Yes |
| DELETE | Remove a resource. | Yes |

**Rule:** If our operation does not match the verb's definition, we are sending a false signal to every consumer, proxy, cache, and monitoring tool in the chain.

### 17.2 Resource Paths Must Be Nouns (The "Action" Exception)

While resource paths should be nouns, we recognize that not every business process maps perfectly to CRUD (Create, Read, Update, Delete).

**The Rule of "Sub-Resources"**

When we need to trigger a state transition that is more complex than a simple PATCH, use a POST on a sub-resource.

- **Option A (The Purist/Noun):** `POST /orders/:id/cancellations`
  - Logic: We are creating a "Cancellation Resource."
  - Benefit: We can return a `201 Created` with the cancellation details.
- **Option B (The Pragmatic/Command):** `POST /orders/:id/cancel`
  - Logic: We are treating the "action" as a sub-resource endpoint.
  - Constraint: This must be a POST. Never use GET or PUT with a verb in the URL.

**DTT Standard Recommendation:**

We prefer Option A because it scales. If tomorrow we need to "Undo" a cancellation, `DELETE /orders/:id/cancellation` makes sense. If we use `/cancel`, we end up with an ugly `/uncancel` endpoint.

**The "Scalability Test":** Before choosing a verb-based path like `/cancel`, ask: "Will I ever need to see the history or details of this action?" If yes, use the noun `/cancellation`.

| ❌ Wrong | ✅ Right | Why |
| --- | --- | --- |
| `PUT /update-payment-contracts` | `PUT /payment-contracts` | PUT already means "update" |
| `POST /start-payment-transaction` | `POST /payment-transactions` | POST already means "create/start" |
| `GET /check-follow-up-exhausted/:id` | `GET /:id/follow-up-status` | GET already means "retrieve" |
| `PATCH /verify-claim/:id` | `POST /:id/verify` | A command is better as POST on a sub-resource |
| `GET /cancel-order/:id` | `POST /orders/:id/cancellation` | Actions must be POST and scoped to the resource |
| `POST /update-status/:id` | `PATCH /orders/:id/status` | Simple field updates use PATCH |

### 17.3 Use Kebab-Case Consistently in URL Paths

URLs are case-insensitive by convention but case-sensitive by RFC. Mixing casing styles causes confusion and broken links.

| ❌ Wrong | ✅ Right |
| --- | --- |
| `/payment/invoiceData` | `/payment/invoice-data` |
| `/allUnverifiedClaims` | `/all-unverified-claims` |
| `/allVerifiedNonPsvClaims` | `/all-verified-non-psv-claims` |

**Rule:** Always use kebab-case (lowercase with hyphens) in URL paths. Reserve camelCase for JSON request/response bodies.

### 17.4 One Route, One Handler — No Silent Aliases

Every route in the API is a contract. If two distinct paths point to the same handler, the consumer has no way to know that. It creates a false expectation that the paths behave differently.

**Rule:** If a route path implies a specific domain action (e.g., `/appeal/:id`), it must map to a handler that performs that specific action — not a generic catch-all.

### 17.5 Resource Identity Belongs in the Path, Not in Query Parameters

REST identifies resources through URL hierarchy. The primary resource being acted upon must always be a path parameter.

| Use | For |
| --- | --- |
| Path parameters (`/:id`) | Resource identity — *which* resource |
| Query parameters (`?key=value`) | Filters, sorting, pagination, optional modifiers — *how* to fetch |

### 17.6 One Controller, One Bounded Resource

A controller should own a single resource and its direct sub-resources. When a controller starts managing payments, PDF generation, report transfers, migration scripts, and suspicion flagging — all under one roof — it has become a God Controller.

**Rule:** If a group of routes shares no service-layer logic with the core CRUD routes, it belongs in its own controller.

---

## 18. Defensive Programming & Boundary Validation

Do not trust the data coming from outside our immediate function scope.

- **18.1 Fail Fast:** Validate inputs at the very top of the function. If a required ID is null, throw immediately before performing expensive DB or Network operations.
- **18.2 Null/Undefined Safety:** Use Optional Chaining (`?.`) and Nullish Coalescing (`??`) intentionally. Avoid the non-null assertion operator (`!`) — it is a lie to the compiler that usually results in runtime crashes.
- **18.3 Immutable by Default:** Use `readonly` for class properties and `ReadonlyArray<T>` for lists to prevent accidental state mutation in business logic.

```typescript
// ❌ BAD: Nested "If" logic
async function process(id: string) {
  if (id) {
    const data = await fetch(id);
    if (data.isActive) {
      // business logic...
    }
  }
}

// ✅ GOOD: Guard Clauses (Fail Fast)
async function process(id: string) {
  if (!id) {
    throw new InvalidInputException('ID required');
  }
  
  const data = await fetch(id);
  if (!data.isActive) {
    return; // Exit early
  } 

  // business logic stays at indentation level 0
}
```

---

## 19. The "Rule of Three" for Refactoring

We balance our commitment to DRY (Section 1) with our goal to Avoid Over-Engineering (Section 16) by following the "Rule of Three."

1. **First Occurrence:** We write the code to solve the immediate problem. We prioritize clarity and delivery.
2. **Second Occurrence:** When we encounter a similar requirement, we may duplicate the logic if the shared abstraction isn't yet obvious. We avoid "Premature Abstraction."
3. **Third Occurrence:** Once we see the pattern a third time, we stop. We now have enough context to extract the logic into a shared utility, service, or component.

**Our Goal:** We ensure our abstractions are discovered through usage, not guessed through anticipation.

---

## 20. Environment & Configuration Management

In our AWS-centric environment, how we handle configuration is a core security and stability concern.

- **20.1 No Hardcoded Configuration:** We never hardcode ARNs, DynamoDB Table names, SQS URLs, or API endpoints. We always leverage environment variables.
- **20.2 Centralized Config Validation:** We avoid scattering `process.env` calls throughout our business logic. Instead, we collect and validate our settings into a single Config object or Constants file.
- **20.3 Fail Fast on Boot:** Our services must validate all required environment variables during the bootstrap/startup phase. We prefer a service that fails to start over a service that crashes mid-execution due to a missing `API_KEY`.

---

## 21. Git & Version Control Standards

Our clean code standards extend to our Git history. We treat our commit log as a narrative for future maintainers.

- **21.1 Atomic Commits:** We ensure each commit performs a single, logical task. We do not mix feature logic with unrelated linting or reformatting changes.
- **21.2 Descriptive Imperative Mood:** We write our commit messages in the imperative mood (e.g., `feat: add validation to workflow` instead of `added some stuff`).
- **21.3 Clean History:** We squash our "Work in Progress" (WIP) commits before merging to our main branch. We want our history to read like well-structured prose, showing only the intentional evolution of our system.

---

## 22. Complexity & Performance Awareness

In a distributed, cloud-native environment, inefficient code doesn't just run slowly — it directly increases our AWS bill and risks system-wide throttling. We write code that is "Scale-Aware."

### 22.1 Algorithmic Efficiency (Big O)

We avoid O(N²) operations in our business logic. Nested loops that search or filter large arrays create exponential performance degradation as our data grows.

- **The Rule:** We avoid using `.find()`, `.filter()`, or `.includes()` inside another loop.
- **The Practical Goal:** We use Maps or Sets for constant-time O(1) lookups. If we need to correlate two lists, we convert one into a Map first.

```typescript
// ❌ BAD: O(N * M) Complexity
const updatedUsers = users.map(user => {
  const profile = profiles.find(p => p.userId === user.id); // Search inside a loop
  return { ...user, ...profile };
});

// ✅ GOOD: O(N + M) Complexity
const profileMap = new Map(profiles.map(p => [p.userId, p]));
const updatedUsers = users.map(user => ({
  ...user,
  ...(profileMap.get(user.id) || {})
}));
```

### 22.2 Avoiding the "N+1 Problem" in Infrastructure

We treat our Database and External Service calls as expensive resources. We never perform I/O operations inside a loop if a batch alternative exists.

- **The Rule:** We do not call `getItem` or `putItem` for every element in a list.
- **The Solution:** We leverage DynamoDB's `BatchGetItem` or `BatchWriteItem`. For external APIs, we use bulk endpoints whenever provided by the service client.
- **Infrastructure Impact:** Minimizing round-trips reduces latency, preserves our "Read/Write Capacity Units" (RCU/WCU), and prevents "Lambda Execution Timeout" errors.

### 22.3 Memory Management with Large Datasets

When processing thousands of records (e.g., a bulk migration or a large SQS batch), we avoid loading the entire dataset into memory at once. We use Streams or Pagination to keep our memory footprint stable and prevent Out of Memory (OOM) crashes.

---

## Examples

The following list contains examples from our existing codebase that do not align with these updated standards. We should avoid these patterns in new development.

- [Over Engineer Example - Office Service V2 Module](./Over%20Engineer%20Example%20-%20Office%20Service%20V2%20Module.md)
- [Poor API Examples](./Poor%20API%20Examples.md)
- [Poor Class Name Examples](./Poor%20Class%20Name%20Examples.md)
- [Poor Variable/Parameters/Arguments Naming Examples](./Poor%20Variable-Parameters-rguments%20Naming%20Examples.md)
- [Poor Function Naming Examples](./Poor%20Function%20Naming%20Examples.md)
- [Poor Function Arguments Examples](./Poor%20Function%20Arguments%20Examples.md)
- [Poor Function Implementation - Update Claim](./Poor%20Function%20Implementation%20-%20Update%20Claim.md)
- [Poor Function Implementation - handlePayment](./Poor%20Function%20Implementation%20-%20handlePayment.md)
- [Poor Function Implementation - Get/Fetch With Side Effects](./Poor%20Function%20Implementation%20-%20Get-Fetch%20With%20Side%20Effects.md)
- [Poor Function Implementation - ResponseAutomation](./Poor%20Function%20Implementation%20-%20ResponseAutomation.md)
- [Poor Function Implementation - Create Workflow](./Poor%20Function%20Implementation%20-%20Create%20Workflow.md)
- [Poor Class/Interface Design - Predicate](./Poor%20Class-Interface%20Design%20-%20Predicate.md)
- [Poor Class/Interface Design - ProcessAgent](./Poor%20Class-Interface%20Design%20-%20ProcessAgent.md)
- [Poor Class/Interface Design - WorkflowSLAService](./Poor%20Class-Interface%20Design%20-%20WorkflowSLAService.md)
- [Poor Class/Interface Design - IARequirementsHelper](./Poor%20Class-Interface%20Design%20-%20IARequirementsHelper.md)

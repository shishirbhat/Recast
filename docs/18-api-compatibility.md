# API contract and compatibility

## The contract
- **Source:** `packages/api-core/src/openapi.ts` (OpenAPI 3.1).
- **Served at** `GET /v1/openapi.json`, limited to the operations the calling key may use (`docs/RELEASE_STATES.md`). Unreleased endpoints are not advertised.
- Every operation names the release capability that gates it (`x-recast-capability`).
- Response objects are **closed** (`additionalProperties: false`), so the server cannot leak a field by accident. That is a rule for the server, not for clients (see below).

## How it is enforced
| Check | Where | What fails it |
|---|---|---|
| Every response a test produces matches the contract | `packages/api-core/test/contract-guard.ts`, used by the API, placement and release tests (memory and Postgres stores, fake Google) | a missing, renamed or extra field, a wrong type, a status the operation does not declare |
| Every response the SDK reads in its tests | `packages/sdk/test/{integration,place}.test.ts` via `withContractCheck` | the same, on the SDK's real HTTP traffic |
| The built Next.js server (`next build && next start`) | `apps/api/test/e2e.test.ts` | the same, on 12 requests including 400, 401, 403 and 415 answers |
| The document itself | `packages/api-core/test/contract.test.ts` | a `$ref` that does not resolve, a duplicate operation id, a status the server code throws that no operation declares |
| **No breaking change within v1** | `contract.test.ts` against the committed baseline `packages/api-core/contract/v1.json` | any rule below |

Updating the baseline: `pnpm --filter @recast/api-core contract:snapshot`. It **refuses** to write a baseline that is a breaking change against the current one. Adding to v1 therefore needs a reviewed snapshot update; breaking v1 needs v2.

## What is breaking (never within v1)
- removing an operation;
- removing a success (2xx) status from an operation;
- removing a response field;
- making an always-present response field optional;
- changing a constant (for example `status: "placed"`);
- making a request field required that was optional, or adding a new required request field.

## What is not breaking (may happen within v1, without notice)
- new operations, new optional request fields, new response fields;
- new error codes or error statuses on an operation;
- new values in open sets: `status` of a resolve result, destinations, object types, bridge reliability, error `code`;
- new headers;
- error `message` wording (match on `code`, never on `message`).

## What clients must do
- **Ignore fields you do not know.** The server adds them within v1.
- **Treat an unknown resolve `status` as unresolved.** Do not act on it. The SDK does this.
- **Treat an unknown placement status as not placed.** The SDK returns `outcome_unknown` and tells you to upgrade. It never reports success it cannot recognise (`packages/sdk/test/compat.test.ts`).
- **Branch on `error.code`, and honour `Retry-After`** on 429 and 409 `idempotency_key_in_use`.
- **Never retry a placement after a 202.** Reconcile it (`docs/12-api.md`).

## Versions
- The major version is in the path (`/v1`). A breaking change is a new path (`/v2`), served next to the old one.
- `X-Recast-Version: 1.x.y` may be sent. A different major version is refused with `400 unsupported_version`. Every answer carries `Recast-Schema-Version`.
- **Deprecation:** a deprecated version gets `Deprecation: true` and a `Sunset` date on every answer. The minimum notice is **6 months** for a public endpoint. Internal and private endpoints (release states) can change with notice to the design partners using them.
- **SDK versions:** `@recast/sdk` major versions follow API majors. A minor SDK release may add methods for new operations, and never changes what an existing method returns for an existing answer.

## Not covered yet
- No published SDK or hosted spec yet, so no external developer depends on this today (**P** not reached).
- Request schemas are documented, not enforced by the validator. The server's own parsing (`parseResolveInput`, placement parsing) is the enforcement, and its errors are covered by the tests above.
- No generated clients. The spec is hand-written next to the code it describes, and the tests keep the two together.

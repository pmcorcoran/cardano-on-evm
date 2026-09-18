# @cardano-on-evm/enrollment

Initial 0.1.0 MIT-licensed reusable enrollment services with independently implemented
backend address derivation. `createProfileEnrollmentService` scopes challenges
to an application origin, Cardano address/network, Base chain and account
configuration. `createTableEnrollmentService` supports experimental-general.
Portable derivation is unconditional; chain ID still binds every challenge.
The backend maintains independent ABI/salt/CREATE2 calculations.
`createEnrollmentHandler` exposes framework-neutral Fetch routes
for `/challenge` and `/enroll`.

`ChallengeStore` is replaceable. `MemoryChallengeStore` supports one process;
`SqliteChallengeStore` is available from `@cardano-on-evm/enrollment/sqlite` and
uses Node's SQLite implementation. Successful consumption must remain atomic in
any replacement store. Scope comes from server configuration, never request
claims. Hosts supply TLS, application authentication and request/rate limits.

Challenges are unpredictable, expiring and one-time. Public keys must match the
address credential. Enrollment creates no onchain spending authority for the
server and does not sign an account operation. See `docs/sdk.md` in the source
release for a complete example.

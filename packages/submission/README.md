# @cardano-on-evm/submission

Initial 0.1.0 MIT-licensed independent submission adapters. `createPublicBundlerAdapter` and
`createPrivateBundlerAdapter` use standard ERC-4337 methods with a replaceable
`Rpc` transport. `createDirectAdapter` uses ordinary RPC and a supplied funded
transaction sender to call EntryPoint 0.7 `handleOps`.

All adapters consume the same authorized operation/context and expose `submit`
and `status`. Receipts must contain exactly one matching EntryPoint event with
the expected account, nonce and hash. An outer successful transaction with a
failed account call is reported as `execution-reverted`.

`httpRpc` supports server-only authentication headers, timeouts and request
spacing, and redacts endpoint credentials from errors. Persist operation and
transaction hashes before retries. A funded sender, bundler token or optional
paymaster supplies delivery/funding, never the Cardano account's authorization.
The standalone private service is a separate installation in the source release.

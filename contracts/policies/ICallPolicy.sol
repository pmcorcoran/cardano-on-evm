// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Stateless execution policy used by RestrictedExecutionHook.
/// @dev Configuration is fixed in the hook. Implementations must not depend on
/// mutable administrators, proxies or unreviewed downstream authorization.
interface ICallPolicy {
    function validateConfig(bytes calldata config) external view;
    function checkCall(address account, address target, uint256 value, bytes calldata data, bytes calldata config)
        external view returns (bool);
}

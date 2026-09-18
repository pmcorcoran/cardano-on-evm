// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IHook} from "../../vendor/kernel/src/interfaces/IERC7579Modules.sol";
import {ICallPolicy} from "./ICallPolicy.sol";

/// @notice Immutable Kernel root hook: CALL-only, canonical encoding and a fixed policy.
/// @dev Its authority model REQUIRES the canonical ProfileAccountFactory with no
/// other initial modules. Kernel's immutable EntryPoint is the only caller that
/// can reach execution; the Cardano root is deliberately not also a hook and
/// rejects ERC-1271/enable-mode signatures. See docs/policies.md for the proof.
contract RestrictedExecutionHook is IHook {
    struct Execution { address target; uint256 value; bytes callData; }
    address public immutable entryPoint;
    ICallPolicy public immutable policy;
    bytes32 public immutable policyCodeHash;
    bytes32 public immutable configHash;
    bytes public configuration;
    bytes4 public constant EXECUTE = bytes4(keccak256("execute(bytes32,bytes)"));
    bytes32 public constant SINGLE = bytes32(0);
    bytes32 public constant BATCH = bytes32(uint256(1) << 248);
    error RestrictedExecution();

    constructor(address ep, ICallPolicy selectedPolicy, bytes memory config) {
        require(ep != address(0) && address(selectedPolicy).code.length != 0, "Policy and EntryPoint required");
        require(config.length <= 16384, "Config length");
        selectedPolicy.validateConfig(config);
        entryPoint = ep; policy = selectedPolicy;
        policyCodeHash = address(selectedPolicy).codehash;
        configHash = keccak256(config); configuration = config;
    }
    function onInstall(bytes calldata data) external payable { require(data.length == 0, "Immutable hook"); }
    function onUninstall(bytes calldata) external payable { revert RestrictedExecution(); }
    function isInitialized(address) external pure returns (bool) { return true; }
    function isModuleType(uint256 id) external pure returns (bool) { return id == 4; }

    function preCheck(address caller, uint256 value, bytes calldata execution) external payable returns (bytes memory) {
        if (caller != entryPoint || value != 0 || execution.length < 4 || bytes4(execution[:4]) != EXECUTE) revert RestrictedExecution();
        if (address(policy).codehash != policyCodeHash) revert RestrictedExecution();
        (bytes32 mode, bytes memory calls) = abi.decode(execution[4:], (bytes32, bytes));
        if (keccak256(execution) != keccak256(abi.encodeWithSelector(EXECUTE, mode, calls))) revert RestrictedExecution();
        bytes memory config = configuration;
        if (mode == SINGLE) {
            // Packed single call: target(20) | value(32) | calldata.
            if (calls.length < 52) revert RestrictedExecution();
            address target; uint256 amount;
            assembly ("memory-safe") { target := shr(96, mload(add(calls, 32))) amount := mload(add(calls, 52)) }
            bytes memory data = new bytes(calls.length - 52);
            for (uint256 i; i < data.length; ++i) data[i] = calls[i + 52];
            _check(msg.sender, target, amount, data, config);
        } else if (mode == BATCH) {
            Execution[] memory batch = abi.decode(calls, (Execution[]));
            if (batch.length == 0 || batch.length > 64 || keccak256(calls) != keccak256(abi.encode(batch))) revert RestrictedExecution();
            // Check the entire batch before the account performs its first call.
            for (uint256 i; i < batch.length; ++i) _check(msg.sender, batch[i].target, batch[i].value, batch[i].callData, config);
        } else revert RestrictedExecution();
        return "";
    }
    function _check(address account, address target, uint256 value, bytes memory data, bytes memory config) private view {
        // Always enforced even if a custom policy would allow these destinations.
        if (target == account || target == address(0)) revert RestrictedExecution();
        if (!policy.checkCall(account, target, value, data, config)) revert RestrictedExecution();
    }
    function postCheck(bytes calldata) external payable {}
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ICallPolicy} from "./ICallPolicy.sol";

/// @notice Allows CALLs, including value transfers, only to selected targets.
contract TargetAllowlistPolicy is ICallPolicy {
    function validateConfig(bytes calldata config) external pure {
        address[] memory targets = abi.decode(config, (address[]));
        require(targets.length > 0 && targets.length <= 64, "Target count");
        require(keccak256(config) == keccak256(abi.encode(targets)), "Canonical config");
        for (uint256 i; i < targets.length; ++i) {
            require(targets[i] != address(0), "Zero target");
            if (i > 0) require(targets[i - 1] < targets[i], "Sorted unique targets");
        }
    }
    function checkCall(address, address target, uint256, bytes calldata, bytes calldata config)
        external pure returns (bool)
    {
        address[] memory targets = abi.decode(config, (address[]));
        for (uint256 i; i < targets.length; ++i) if (target == targets[i]) return true;
        return false;
    }
}

/// @notice Target-specific function selectors, with explicit value/empty-data permissions.
contract SelectorAllowlistPolicy is ICallPolicy {
    struct Rule { address target; bytes4[] selectors; bool allowEmpty; bool allowValue; }
    function validateConfig(bytes calldata config) external pure {
        Rule[] memory rules = abi.decode(config, (Rule[]));
        require(rules.length > 0 && rules.length <= 64, "Rule count");
        require(keccak256(config) == keccak256(abi.encode(rules)), "Canonical config");
        for (uint256 i; i < rules.length; ++i) {
            Rule memory rule = rules[i];
            require(rule.target != address(0), "Zero target");
            require(rule.selectors.length <= 64 && (rule.selectors.length > 0 || rule.allowEmpty), "Selector count");
            if (i > 0) require(rules[i - 1].target < rule.target, "Sorted unique targets");
            for (uint256 j = 1; j < rule.selectors.length; ++j) {
                require(rule.selectors[j - 1] < rule.selectors[j], "Sorted unique selectors");
            }
        }
    }
    function checkCall(address, address target, uint256 value, bytes calldata data, bytes calldata config)
        external pure returns (bool)
    {
        Rule[] memory rules = abi.decode(config, (Rule[]));
        for (uint256 i; i < rules.length; ++i) {
            Rule memory rule = rules[i];
            if (rule.target != target) continue;
            if (value != 0 && !rule.allowValue) return false;
            if (data.length == 0) return rule.allowEmpty;
            if (data.length < 4) return false;
            for (uint256 j; j < rule.selectors.length; ++j) if (bytes4(data[:4]) == rule.selectors[j]) return true;
            return false;
        }
        return false;
    }
}

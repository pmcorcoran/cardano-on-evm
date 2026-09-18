// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @dev Local-only adversaries for testing account authority boundaries.
contract PolicyAdversary {
    uint256 public failedReentries;
    function reenter(address account, bytes calldata data) external {
        (bool success,) = account.call(data);
        require(!success, "Account authority bypassed");
        failedReentries++;
    }
    function onInstall(bytes calldata) external payable {}
    function onUninstall(bytes calldata) external payable {}
    function isInitialized(address) external pure returns (bool) { return true; }
    function isModuleType(uint256) external pure returns (bool) { return true; }
    function preCheck(address, uint256, bytes calldata) external pure returns (bytes memory) { return ""; }
    function postCheck(bytes calldata) external pure {}
    function isValidSignatureWithSender(address, bytes32, bytes calldata) external pure returns (bytes4) { return 0x1626ba7e; }
    fallback() external payable { assembly { mstore(0, 0) return(0, 32) } }
}

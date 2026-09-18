// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {LibClone} from "solady/utils/LibClone.sol";
import {PreparedTableFactory} from "../experiments/PreparedKeyFactory.sol";
import {RestrictedExecutionHook} from "../policies/RestrictedExecutionHook.sol";
import {ICallPolicy} from "../policies/ICallPolicy.sol";

interface IKernelEntryPoint { function entrypoint() external view returns (address); }

/// @notice A prepared, immutable profile and its canonical Kernel account factory.
/// @dev Preparation occurs outside UserOperation validation. createAccount does
/// one CREATE2 and cannot accept initializers, alternate validators or modules.
contract ProfileAccountFactory {
    address public immutable implementation;
    address public immutable entryPoint;
    address public immutable validator;
    address public immutable hook;
    bytes32 public immutable profileHash;
    bytes32 public constant PROFILE_DOMAIN = keccak256("cardano-kernel:profile:v1");
    bytes32 public constant ACCOUNT_DOMAIN = keccak256("cardano-kernel:profile-account:v1");
    bytes4 private constant INITIALIZE = bytes4(keccak256("initialize(bytes21,address,bytes,bytes,bytes[])"));
    event AccountCreated(address indexed account, bytes32 indexed namespace, uint256 index);

    constructor(address kernelImplementation, PreparedTableFactory tableFactory, bytes32 key, uint256 ex, bytes memory headers, ICallPolicy policy, bytes memory policyConfig, bytes32 expectedPolicyCodeHash) {
        require(kernelImplementation.code.length > 0 && address(tableFactory).code.length > 0, "Infrastructure required");
        address ep = tableFactory.entryPoint();
        require(IKernelEntryPoint(kernelImplementation).entrypoint() == ep, "EntryPoint mismatch");
        address module = tableFactory.getAddress(key, ex, headers);
        require(module.code.length > 0, "Prepare checked key first");
        implementation = kernelImplementation; entryPoint = ep; validator = module;
        if (address(policy) == address(0)) {
            require(policyConfig.length == 0 && expectedPolicyCodeHash == bytes32(0), "General profile has no policy config");
            hook = address(0);
        } else {
            require(address(policy).codehash == expectedPolicyCodeHash, "Policy code mismatch");
            hook = address(new RestrictedExecutionHook(ep, policy, policyConfig));
        }
        profileHash = keccak256(abi.encode(PROFILE_DOMAIN, kernelImplementation, address(tableFactory), ep, key, keccak256(headers), address(policy), expectedPolicyCodeHash, keccak256(policyConfig)));
    }

    function initializeData() public view returns (bytes memory) {
        return abi.encodeWithSelector(INITIALIZE, bytes21(abi.encodePacked(hex"01", validator)), hook, bytes(""), bytes(""), new bytes[](0));
    }
    function accountSalt(bytes32 namespace, uint256 index) public pure returns (bytes32) {
        return keccak256(abi.encode(ACCOUNT_DOMAIN, namespace, index));
    }
    function getAddress(bytes32 namespace, uint256 index) public view returns (address) {
        bytes32 actualSalt = keccak256(abi.encodePacked(initializeData(), accountSalt(namespace, index)));
        return LibClone.predictDeterministicAddressERC1967(implementation, actualSalt, address(this));
    }
    function createAccount(bytes32 namespace, uint256 index) external payable returns (address account) {
        bytes memory data = initializeData();
        bytes32 actualSalt = keccak256(abi.encodePacked(data, accountSalt(namespace, index)));
        bool exists;
        (exists, account) = LibClone.createDeterministicERC1967(msg.value, implementation, actualSalt);
        if (!exists) {
            (bool success,) = account.call(data);
            require(success, "Profile initialization failed");
            emit AccountCreated(account, namespace, index);
        }
    }
}

/// @notice Permissionless, reproducible preparation of general/restricted factories.
/// @dev No operator, attestation, sponsor or submitter is given account authority.
contract ProfilePreparationFactory {
    address public immutable implementation;
    PreparedTableFactory public immutable tableFactory;
    bytes32 public constant DOMAIN = keccak256("cardano-kernel:profile-preparation:v1");
    event ProfilePrepared(address indexed profileFactory, bytes32 indexed key, address indexed policy);
    constructor(address kernelImplementation, PreparedTableFactory checkedTableFactory) {
        require(IKernelEntryPoint(kernelImplementation).entrypoint() == checkedTableFactory.entryPoint(), "EntryPoint mismatch");
        implementation = kernelImplementation; tableFactory = checkedTableFactory;
    }
    function initCode(bytes32 key, uint256 ex, bytes memory headers, ICallPolicy policy, bytes memory config, bytes32 policyCodeHash) public view returns (bytes memory) {
        return abi.encodePacked(type(ProfileAccountFactory).creationCode, abi.encode(implementation, tableFactory, key, ex, headers, policy, config, policyCodeHash));
    }
    function getAddress(bytes32 key, uint256 ex, bytes memory headers, ICallPolicy policy, bytes memory config, bytes32 policyCodeHash) public view returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(hex"ff", address(this), DOMAIN, keccak256(initCode(key, ex, headers, policy, config, policyCodeHash)))))));
    }
    function prepare(bytes32 key, uint256 ex, bytes calldata headers, ICallPolicy policy, bytes calldata config, bytes32 policyCodeHash) external returns (address profileFactory) {
        tableFactory.prepare(key, ex, headers);
        profileFactory = getAddress(key, ex, headers, policy, config, policyCodeHash);
        if (profileFactory.code.length != 0) return profileFactory;
        require(address(new ProfileAccountFactory{salt: DOMAIN}(implementation, tableFactory, key, ex, headers, policy, config, policyCodeHash)) == profileFactory, "Profile address mismatch");
        emit ProfilePrepared(profileFactory, key, address(policy));
    }
}

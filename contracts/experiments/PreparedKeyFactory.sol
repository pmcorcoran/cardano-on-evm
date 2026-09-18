// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {PreparedKeyValidator, PreparedTableValidator} from "./KernelPathValidator.sol";

/// @notice Permissionless, deterministic preparation for the feasibility module.
/// @dev No owner or operator role. Constructor checks bind all auxiliary data to
/// the public key; preparation supplies no authorization to spend account funds.
contract PreparedKeyFactory {
    address public immutable entryPoint;
    bytes32 public constant DOMAIN = keccak256("cardano-kernel:prepared-key:v1");
    event KeyPrepared(bytes32 indexed publicKey, bytes32 indexed headersHash, address indexed validator);

    constructor(address ep) { require(ep != address(0), "EntryPoint required"); entryPoint = ep; }

    function salt(bytes32 key, bytes memory headers) public pure returns (bytes32) {
        return keccak256(abi.encode(DOMAIN, key, keccak256(headers)));
    }

    function initCode(bytes32 key, uint256 ex, bytes memory headers) public view returns (bytes memory) {
        return abi.encodePacked(type(PreparedKeyValidator).creationCode, abi.encode(entryPoint, key, ex, headers));
    }

    function getAddress(bytes32 key, uint256 ex, bytes memory headers) public view returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(hex"ff", address(this), salt(key, headers), keccak256(initCode(key, ex, headers)))))));
    }

    function prepare(bytes32 key, uint256 ex, bytes memory headers) external returns (address validator) {
        validator = getAddress(key, ex, headers);
        if (validator.code.length != 0) return validator;
        address deployed = address(new PreparedKeyValidator{salt: salt(key, headers)}(entryPoint, key, ex, headers));
        require(deployed == validator, "Preparation address mismatch");
        emit KeyPrepared(key, keccak256(headers), validator);
    }
}

/// @notice Permissionless, deterministic preparation for the feasibility module.
/// @dev No owner or operator role. Constructor checks bind all auxiliary data to
/// the public key; preparation supplies no authorization to spend account funds.
contract PreparedTableFactory {
    address public immutable entryPoint;
    bytes32 public constant DOMAIN = keccak256("cardano-kernel:prepared-table:v1");
    event KeyPrepared(bytes32 indexed publicKey, bytes32 indexed headersHash, address indexed validator);

    constructor(address ep) { require(ep != address(0), "EntryPoint required"); entryPoint = ep; }

    function salt(bytes32 key, bytes memory headers) public pure returns (bytes32) {
        return keccak256(abi.encode(DOMAIN, key, keccak256(headers)));
    }

    function initCode(bytes32 key, uint256 ex, bytes memory headers) public view returns (bytes memory) {
        return abi.encodePacked(type(PreparedTableValidator).creationCode, abi.encode(entryPoint, key, ex, headers));
    }

    function getAddress(bytes32 key, uint256 ex, bytes memory headers) public view returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(hex"ff", address(this), salt(key, headers), keccak256(initCode(key, ex, headers)))))));
    }

    function prepare(bytes32 key, uint256 ex, bytes memory headers) external returns (address validator) {
        validator = getAddress(key, ex, headers);
        if (validator.code.length != 0) return validator;
        address deployed = address(new PreparedTableValidator{salt: salt(key, headers)}(entryPoint, key, ex, headers));
        require(deployed == validator, "Preparation address mismatch");
        emit KeyPrepared(key, keccak256(headers), validator);
    }
}

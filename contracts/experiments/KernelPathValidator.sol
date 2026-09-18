// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IValidator} from "../../vendor/kernel/src/interfaces/IERC7579Modules.sol";
import {PackedUserOperation} from "../../vendor/kernel/src/interfaces/PackedUserOperation.sol";
import {Kernel} from "../../vendor/kernel/src/Kernel.sol";
import {KernelFactory} from "../../vendor/kernel/src/factory/KernelFactory.sol";
import {CardanoEd25519} from "../crypto/CardanoEd25519.sol";
import {SCL_EIP6565} from "../../vendor/scl/src/lib/libSCL_EIP6565.sol";
import {SCL_sha512} from "../../vendor/scl/src/hash/SCL_sha512.sol";
import {ecCheckedMulAdd} from "../crypto/CheckedMul.sol";
import {ecPrecomputedMulAdd} from "../crypto/PrecomputedMul.sol";
import {CurveTable, CurvePrecompute} from "../crypto/EightDimensional.sol";
import {p, n, d, a, gx, gy, gpow2p128_x, gpow2p128_y} from "../../vendor/scl/src/fields/SCL_wei25519.sol";

/// @notice Full-path feasibility module; not the final restricted-account module.
/// @dev General root authority includes Kernel administration. No policy support.
/// New key validation and SHA512 integration have not been independently audited.
contract KernelPathValidator is IValidator {
    struct Owner { bytes32 publicKey; uint256 wx; uint256 wy; bytes32 headerHash; }
    mapping(address => Owner) public owners;
    address public immutable entryPoint;
    bytes32 public constant DOMAIN = keccak256("cardano-kernel:operation:v1");

    constructor(address ep) { entryPoint = ep; }
    function onInstall(bytes calldata data) external payable virtual {
        require(owners[msg.sender].publicKey == bytes32(0), "Already installed");
        (bytes32 key, uint256 ex, bytes memory headers) = abi.decode(data, (bytes32, uint256, bytes));
        owners[msg.sender] = _checkedOwner(key, ex, headers);
    }
    function _checkedOwner(bytes32 key, uint256 ex, bytes memory headers) internal view returns (Owner memory) {
        require(headers.length > 0 && headers.length <= 256, "Header length");
        uint256 compressed = SCL_sha512.Swap256(uint256(key));
        uint256 ey = compressed & ((uint256(1) << 255) - 1);
        require(ex > 0 && ex < p && ey < p && ey != 1, "Key range");
        require((ex & 1) == (compressed >> 255), "Key sign");
        uint256 xx = mulmod(ex, ex, p); uint256 yy = mulmod(ey, ey, p);
        require(addmod(yy, p - xx, p) == addmod(1, mulmod(d, mulmod(xx, yy, p), p), p), "Key curve");
        (uint256 wx, uint256 wy) = SCL_EIP6565.Edwards2WeierStrass(ex, ey);
        // Onchain subgroup check: service-supplied coordinates are never trusted.
        require(_primeOrder(wx, wy), "Key subgroup");
        return Owner(key, wx, wy, keccak256(headers));
    }
    function _primeOrder(uint256 wx, uint256 wy) internal view virtual returns (bool) {
        uint256[6] memory q = [wx, wy, p, a, gx, gy];
        (uint256 nx, uint256 ny) = ecCheckedMulAdd(q, 0, n);
        return nx == 0 && ny == 0;
    }
    function onUninstall(bytes calldata) external payable virtual { delete owners[msg.sender]; }
    function isInitialized(address account) external view virtual returns (bool) { return owners[account].publicKey != bytes32(0); }
    function isModuleType(uint256 id) external pure returns (bool) { return id == 1; }
    function isValidSignatureWithSender(address, bytes32, bytes calldata) external pure returns (bytes4) { return 0xffffffff; }
    function _owner(address account) internal view virtual returns (Owner memory) { return owners[account]; }
    function ownerOf(address account) external view returns (Owner memory) { return _owner(account); }

    function operationHash(PackedUserOperation calldata op) public view returns (bytes32) {
        bytes32 inner = keccak256(abi.encode(op.sender, op.nonce, keccak256(op.initCode), keccak256(op.callData), op.accountGasLimits, op.preVerificationGas, op.gasFees, keccak256(op.paymasterAndData)));
        return keccak256(abi.encode(inner, entryPoint, block.chainid));
    }
    function validateUserOp(PackedUserOperation calldata op, bytes32 suppliedHash) external payable returns (uint256) {
        Owner memory owner = _owner(msg.sender);
        if (owner.publicKey == bytes32(0) || msg.sender != op.sender) return 1;
        // Kernel supports a replayable-signature prefix; reject a rewritten hash.
        // Recompute with this validator's immutable EntryPoint and current chain.
        bytes32 hash = operationHash(op);
        if (hash != suppliedHash) return 1;
        (bytes memory headers, bytes32 r, bytes32 s) = abi.decode(op.signature, (bytes, bytes32, bytes32));
        if (keccak256(headers) != owner.headerHash || headers.length > 256) return 1;
        if (keccak256(op.signature) != keccak256(abi.encode(headers, r, s))) return 1;
        bytes memory headerLength;
        if (headers.length < 24) headerLength = abi.encodePacked(bytes1(uint8(0x40 + headers.length)));
        else if (headers.length < 256) headerLength = abi.encodePacked(hex"58", uint8(headers.length));
        else headerLength = hex"590100";
        bytes32 payload = keccak256(abi.encode(DOMAIN, hash));
        bytes memory signStructure = abi.encodePacked(hex"846a5369676e617475726531", headerLength, headers, hex"405820", payload);
        return _verify(signStructure, r, s, owner) ? 0 : 1;
    }
    function _verify(bytes memory message, bytes32 r, bytes32 s, Owner memory owner) internal view virtual returns (bool) {
        return CardanoEd25519.verify(message, r, s, owner.publicKey, owner.wx, owner.wy);
    }
}

/// @notice Candidate: key checks run in a separate preparation transaction.
/// Preparation has no private authorization material and conveys no authority.
/// Deterministic preparation factory and final profile integration remain pending.
contract PreparedKeyValidator is KernelPathValidator {
    bytes32 public immutable publicKey;
    uint256 public immutable keyWx;
    uint256 public immutable keyWy;
    uint256 public immutable keyWx128;
    uint256 public immutable keyWy128;
    bytes32 public immutable protectedHeaderHash;
    constructor(address ep, bytes32 key, uint256 ex, bytes memory headers) KernelPathValidator(ep) {
        Owner memory owner = _checkedOwner(key, ex, headers);
        publicKey = owner.publicKey; keyWx = owner.wx; keyWy = owner.wy; protectedHeaderHash = owner.headerHash;
        uint256[6] memory q = [owner.wx, owner.wy, p, a, gx, gy];
        (uint256 x128, uint256 y128) = ecCheckedMulAdd(q, 0, uint256(1) << 128);
        keyWx128 = x128; keyWy128 = y128;
        uint256[10] memory precomputed = [owner.wx, owner.wy, x128, y128, p, a, gx, gy, gpow2p128_x, gpow2p128_y];
        // Exercise table validation during preparation, before account creation.
        (uint256 bx, uint256 by) = ecPrecomputedMulAdd(precomputed, 1, 0);
        require(bx == gx && by == gy, "Key precomputation");
    }
    function onInstall(bytes calldata data) external payable override {
        require(data.length == 0, "Immutable validator configuration");
    }
    function onUninstall(bytes calldata) external payable override {}
    // This per-key module is fully configured at construction. Kernel stores
    // whether it is selected as an account validator; no duplicate state here.
    // ownerOf reports the module's key, not proof that a Kernel selected it.
    function isInitialized(address) external pure override returns (bool) { return true; }
    function _owner(address) internal view override returns (Owner memory) {
        return Owner(publicKey, keyWx, keyWy, protectedHeaderHash);
    }
    function _verify(bytes memory message, bytes32 r, bytes32 s, Owner memory owner) internal view override returns (bool) {
        return CardanoEd25519.verifyPrecomputed(message, r, s, owner.publicKey, [keyWx, keyWy, keyWx128, keyWy128]);
    }
}

contract ExperimentCounter {
    uint256 public number;
    function increment(uint256 by) external { number += by; }
}

/// @notice Candidate with an onchain-generated immutable 256-point code table.
contract PreparedTableValidator is KernelPathValidator {
    bytes32 public immutable publicKey;
    uint256 public immutable keyWx;
    uint256 public immutable keyWy;
    bytes32 public immutable protectedHeaderHash;
    address public immutable curveTable;

    constructor(address ep, bytes32 key, uint256 ex, bytes memory headers) KernelPathValidator(ep) {
        Owner memory owner = _checkedOwner(key, ex, headers);
        publicKey = key; keyWx = owner.wx; keyWy = owner.wy; protectedHeaderHash = owner.headerHash;
        curveTable = address(new CurveTable(CurvePrecompute.table(owner.wx, owner.wy)));
    }
    function onInstall(bytes calldata data) external payable override { require(data.length == 0, "Immutable validator configuration"); }
    function onUninstall(bytes calldata) external payable override {}
    function isInitialized(address) external pure override returns (bool) { return true; }
    function _owner(address) internal view override returns (Owner memory) { return Owner(publicKey, keyWx, keyWy, protectedHeaderHash); }
    function _primeOrder(uint256 wx, uint256 wy) internal view override returns (bool) { return CurvePrecompute.primeOrder(wx, wy); }
    function _verify(bytes memory message, bytes32 r, bytes32 s, Owner memory owner) internal view override returns (bool) {
        return CardanoEd25519.verifyTable(message, r, s, owner.publicKey, curveTable);
    }
}

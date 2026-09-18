// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {SCL_EIP6565} from "../../vendor/scl/src/lib/libSCL_EIP6565.sol";
import {Sha512} from "../crypto/Sha512.sol";
import {CardanoEd25519} from "../crypto/CardanoEd25519.sol";
import {EightDimensional} from "../crypto/EightDimensional.sol";

/// @dev Experiment only: extendedKey is supplied by the test, NOT validated.
/// This harness is not an account validator or a deployable ownership module.
contract VerifierHarness {
    function sha512(bytes calldata message) external pure returns (bytes32, bytes32) {
        return Sha512.hash(message);
    }
    function verifyOptimized(bytes calldata message, bytes32 r, bytes32 s, uint256[5] calldata extendedKey)
        external view returns (bool)
    {
        return CardanoEd25519.verify(message, r, s, bytes32(extendedKey[4]), extendedKey[0], extendedKey[1]);
    }
    function verify(bytes calldata message, bytes32 r, bytes32 s, uint256[5] calldata extendedKey)
        external view returns (bool)
    {
        return SCL_EIP6565.Verify_LE(string(message), uint256(r), uint256(s), extendedKey);
    }
    function verifyPrecomputed(bytes calldata message, bytes32 r, bytes32 s, uint256[5] calldata extendedKey)
        external view returns (bool)
    {
        return CardanoEd25519.verifyPrecomputed(message, r, s, bytes32(extendedKey[4]), [extendedKey[0], extendedKey[1], extendedKey[2], extendedKey[3]]);
    }
    function verifyTable(bytes calldata message, bytes32 r, bytes32 s, bytes32 publicKey, address table) external view returns (bool) {
        return CardanoEd25519.verifyTable(message, r, s, publicKey, table);
    }
    function multiplyTable(address table, uint256 u, uint256 v) external view returns (uint256, uint256) {
        return EightDimensional.multiply(table, u, v);
    }
}

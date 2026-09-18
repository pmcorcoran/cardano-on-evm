// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Sha512} from "./Sha512.sol";
import {SCL_EIP6565} from "../../vendor/scl/src/lib/libSCL_EIP6565.sol";
import {SCL_sha512} from "../../vendor/scl/src/hash/SCL_sha512.sol";
import {ecCheckedMulAdd} from "./CheckedMul.sol";
import {ecPrecomputedMulAdd} from "./PrecomputedMul.sol";
import {EightDimensional} from "./EightDimensional.sol";
import {p, n, a, gx, gy, gpow2p128_x, gpow2p128_y, _2pow256modn} from "../../vendor/scl/src/fields/SCL_wei25519.sol";

/// @dev SCL's Ed25519 equation with the bounded SHA-512 implementation above.
/// The caller MUST validate and bind wx/wy to publicKey before persisting a key.
library CardanoEd25519 {
    function verify(bytes memory message, bytes32 r, bytes32 encodedS, bytes32 publicKey, uint256 wx, uint256 wy)
        internal view returns (bool)
    {
        uint256 s = SCL_sha512.Swap256(uint256(encodedS));
        if (s == 0 || s >= n) return false;
        (bytes32 high, bytes32 low) = Sha512.hash(abi.encodePacked(r, publicKey, message));
        uint256 k = addmod(mulmod(SCL_sha512.Swap256(uint256(low)), _2pow256modn, n), SCL_sha512.Swap256(uint256(high)), n);
        uint256[6] memory q = [wx, wy, p, a, gx, gy];
        (uint256 x, uint256 y) = ecCheckedMulAdd(q, s, n - k);
        if (x == 0 && y == 0) return false;
        (x, y) = SCL_EIP6565.WeierStrass2Edwards(x, y);
        return bytes32(SCL_sha512.Swap256(y | ((x & 1) << 255))) == r;
    }

    /// @dev q contains onchain-checked W coordinates for A and 2^128*A.
    function verifyPrecomputed(bytes memory message, bytes32 r, bytes32 encodedS, bytes32 publicKey, uint256[4] memory points)
        internal view returns (bool)
    {
        uint256 s = SCL_sha512.Swap256(uint256(encodedS));
        if (s == 0 || s >= n) return false;
        (bytes32 high, bytes32 low) = Sha512.hash(abi.encodePacked(r, publicKey, message));
        uint256 k = addmod(mulmod(SCL_sha512.Swap256(uint256(low)), _2pow256modn, n), SCL_sha512.Swap256(uint256(high)), n);
        uint256[10] memory q = [points[0], points[1], points[2], points[3], p, a, gx, gy, gpow2p128_x, gpow2p128_y];
        (uint256 x, uint256 y) = ecPrecomputedMulAdd(q, s, n - k);
        if (x == 0 && y == 0) return false;
        (x, y) = SCL_EIP6565.WeierStrass2Edwards(x, y);
        return bytes32(SCL_sha512.Swap256(y | ((x & 1) << 255))) == r;
    }

    function verifyTable(bytes memory message, bytes32 r, bytes32 encodedS, bytes32 publicKey, address table)
        internal view returns (bool)
    {
        uint256 s = SCL_sha512.Swap256(uint256(encodedS));
        if (s == 0 || s >= n) return false;
        (bytes32 high, bytes32 low) = Sha512.hash(abi.encodePacked(r, publicKey, message));
        uint256 k = addmod(mulmod(SCL_sha512.Swap256(uint256(low)), _2pow256modn, n), SCL_sha512.Swap256(uint256(high)), n);
        (uint256 x, uint256 y) = EightDimensional.multiply(table, s, n - k);
        if (x == 0 && y == 0) return false;
        (x, y) = SCL_EIP6565.WeierStrass2Edwards(x, y);
        return bytes32(SCL_sha512.Swap256(y | ((x & 1) << 255))) == r;
    }
}

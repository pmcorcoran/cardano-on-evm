// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

// XYZZ formulas adapted from SCL, Copyright (C) 2024 Renaud Dubois (MIT).
// New table construction, complete exceptional-case handling and 8-dimensional
// integration are unaudited. The table MUST be generated from the checked key.
import {p, a, gx, gy, n} from "../../vendor/scl/src/fields/SCL_wei25519.sol";

/// @dev Immutable data code, prefixed by STOP. Never delegated to or executed.
contract CurveTable {
    constructor(bytes memory points) {
        require(points.length == 16384, "Table length");
        bytes memory runtime = abi.encodePacked(hex"00", points);
        assembly ("memory-safe") { return(add(runtime, 32), mload(runtime)) }
    }
}

library CurvePrecompute {
    struct Point { uint256 x; uint256 y; }

    function inverse(uint256 value) internal view returns (uint256 result) {
        require(value != 0, "Inverse of zero");
        assembly ("memory-safe") {
            let t := mload(0x40)
            mstore(0x40, add(t, 192))
            mstore(t, 32)
            mstore(add(t, 32), 32)
            mstore(add(t, 64), 32)
            mstore(add(t, 96), value)
            mstore(add(t, 128), sub(p, 2))
            mstore(add(t, 160), p)
            if iszero(staticcall(gas(), 5, t, 192, t, 32)) { revert(0, 0) }
            result := mload(t)
        }
    }

    /// @dev Complete affine addition, used only in the preparation transaction.
    function add(Point memory first, Point memory second) internal view returns (Point memory) {
        if (first.x == 0 && first.y == 0) return second;
        if (second.x == 0 && second.y == 0) return first;
        uint256 slope;
        if (first.x == second.x) {
            if (first.y != second.y || first.y == 0) return Point(0, 0);
            slope = mulmod(addmod(mulmod(3, mulmod(first.x, first.x, p), p), a, p), inverse(mulmod(2, first.y, p)), p);
        } else {
            slope = mulmod(addmod(second.y, p - first.y, p), inverse(addmod(second.x, p - first.x, p)), p);
        }
        uint256 x = addmod(addmod(mulmod(slope, slope, p), p - first.x, p), p - second.x, p);
        uint256 y = addmod(mulmod(slope, addmod(first.x, p - x, p), p), p - first.y, p);
        return Point(x, y);
    }

    function primeOrder(uint256 x, uint256 y) internal view returns (bool) {
        Point memory result = Point(0, 0);
        Point memory term = Point(x, y);
        for (uint256 scalar = n; scalar != 0; scalar >>= 1) {
            if ((scalar & 1) != 0) result = add(result, term);
            term = add(term, term);
        }
        return result.x == 0 && result.y == 0;
    }

    function table(uint256 x, uint256 y) internal view returns (bytes memory encoded) {
        Point[8] memory bases;
        bases[0] = Point(gx, gy); bases[4] = Point(x, y);
        for (uint256 i = 1; i < 4; ++i) {
            Point memory g = bases[i - 1]; Point memory q = bases[i + 3];
            for (uint256 j; j < 64; ++j) { g = add(g, g); q = add(q, q); }
            bases[i] = g; bases[i + 4] = q;
        }
        // Entry j is the sum of bases whose bits are set in j. Affine infinity
        // uses (0,0); the verifier explicitly handles such table entries.
        encoded = new bytes(16384);
        for (uint256 i = 1; i < 256; ++i) {
            uint256 bit;
            for (uint256 mask = i; (mask & 1) == 0; mask >>= 1) ++bit;
            uint256 previous = i ^ (uint256(1) << bit);
            Point memory parent;
            assembly ("memory-safe") {
                parent := mload(0x40)
                mstore(0x40, add(parent, 64))
                let position := add(add(encoded, 32), mul(previous, 64))
                mstore(parent, mload(position))
                mstore(add(parent, 32), mload(add(position, 32)))
            }
            Point memory sum = add(parent, bases[bit]);
            assembly ("memory-safe") {
                let position := add(add(encoded, 32), mul(i, 64))
                mstore(position, mload(sum))
                mstore(add(position, 32), mload(add(sum, 32)))
            }
        }
    }
}

library EightDimensional {
    /// @dev Compute u*G + v*A using an immutable, onchain-generated table.
    function multiply(address table, uint256 scalarU, uint256 scalarV) internal view returns (uint256 x, uint256 y) {
        assembly ("memory-safe") {
            // Complete doubling in XYZZ coordinates. All-zero state is infinity.
            function double(state) {
                let px := mload(state)
                let py := mload(add(state, 32))
                let zz := mload(add(state, 64))
                let u := mulmod(2, py, p)
                let v := mulmod(u, u, p)
                let s := mulmod(px, v, p)
                let w := mulmod(u, v, p)
                let m := addmod(mulmod(3, mulmod(px, px, p), p), mulmod(a, mulmod(zz, zz, p), p), p)
                let rx := addmod(mulmod(m, m, p), mulmod(sub(p, 2), s, p), p)
                mstore(state, rx)
                mstore(add(state, 32), addmod(mulmod(m, addmod(s, sub(p, rx), p), p), sub(p, mulmod(w, py, p)), p))
                mstore(add(state, 64), mulmod(v, zz, p))
                mstore(add(state, 96), mulmod(w, mload(add(state, 96)), p))
            }
            // Mixed XYZZ + affine addition, including equal/opposite points.
            function plus(state, qx, qy) {
                if and(iszero(qx), iszero(qy)) { leave }
                if iszero(mload(add(state, 64))) {
                    mstore(state, qx) mstore(add(state, 32), qy)
                    mstore(add(state, 64), 1) mstore(add(state, 96), 1) leave
                }
                let px := mload(state)
                let py := mload(add(state, 32))
                qx := addmod(mulmod(qx, mload(add(state, 64)), p), sub(p, px), p) // H
                qy := addmod(mulmod(qy, mload(add(state, 96)), p), sub(p, py), p) // R
                if iszero(qx) {
                    if iszero(qy) { double(state) leave }
                    mstore(state, 0) mstore(add(state, 32), 0)
                    mstore(add(state, 64), 0) mstore(add(state, 96), 0) leave
                }
                let hh := mulmod(qx, qx, p)
                qx := mulmod(hh, qx, p) // HHH
                let v := mulmod(px, hh, p)
                let rx := addmod(addmod(mulmod(qy, qy, p), sub(p, qx), p), mulmod(sub(p, 2), v, p), p)
                mstore(state, rx)
                mstore(add(state, 32), addmod(mulmod(qy, addmod(v, sub(p, rx), p), p), sub(p, mulmod(py, qx, p)), p))
                mstore(add(state, 64), mulmod(mload(add(state, 64)), hh, p))
                mstore(add(state, 96), mulmod(mload(add(state, 96)), qx, p))
            }
            let points := mload(0x40)
            let state := add(points, 16384)
            let scratch := add(state, 128)
            mstore(0x40, add(scratch, 192))
            mstore(state, 0) mstore(add(state, 32), 0)
            mstore(add(state, 64), 0) mstore(add(state, 96), 0)
            if iszero(eq(extcodesize(table), 16385)) { revert(0, 0) }
            extcodecopy(table, points, 1, 16384)
            for { let bit := 64 } gt(bit, 0) {} {
                bit := sub(bit, 1)
                double(state)
                let u := shr(bit, scalarU)
                let v := shr(bit, scalarV)
                let digit := or(or(and(u, 1), and(shr(63, u), 2)), or(and(shr(126, u), 4), and(shr(189, u), 8)))
                digit := or(digit, shl(4, or(or(and(v, 1), and(shr(63, v), 2)), or(and(shr(126, v), 4), and(shr(189, v), 8)))))
                if digit {
                    let position := add(points, shl(6, digit))
                    plus(state, mload(position), mload(add(position, 32)))
                }
            }
            let zz := mload(add(state, 64))
            if zz {
                mstore(scratch, 32)
                mstore(add(scratch, 32), 32)
                mstore(add(scratch, 64), 32)
                mstore(add(scratch, 96), mload(add(state, 96)))
                mstore(add(scratch, 128), sub(p, 2))
                mstore(add(scratch, 160), p)
                if iszero(staticcall(gas(), 5, scratch, 192, scratch, 32)) { revert(0, 0) }
                let inverseZZZ := mload(scratch)
                y := mulmod(mload(add(state, 32)), inverseZZZ, p)
                zz := mulmod(zz, inverseZZZ, p)
                x := mulmod(mload(state), mulmod(zz, zz, p), p)
            }
        }
    }
}

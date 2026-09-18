// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice SHA-512 with a bounded input and 64-bit arithmetic in EVM words.
/// @dev New, unaudited code. Cross-checked against Node/OpenSSL and noble in tests.
library Sha512 {
    function hash(bytes memory message) internal pure returns (bytes32 high, bytes32 low) {
        require(message.length <= 4096, "SHA512 input limit");
        bytes memory padded = abi.encodePacked(
            message, bytes1(0x80), new bytes((239 - (message.length % 128)) % 128), uint128(message.length * 8)
        );
        bytes memory constants = hex"428a2f98d728ae227137449123ef65cdb5c0fbcfec4d3b2fe9b5dba58189dbbc3956c25bf348b53859f111f1b605d019923f82a4af194f9bab1c5ed5da6d8118d807aa98a303024212835b0145706fbe243185be4ee4b28c550c7dc3d5ffb4e272be5d74f27b896f80deb1fe3b1696b19bdc06a725c71235c19bf174cf692694e49b69c19ef14ad2efbe4786384f25e30fc19dc68b8cd5b5240ca1cc77ac9c652de92c6f592b02754a7484aa6ea6e4835cb0a9dcbd41fbd476f988da831153b5983e5152ee66dfaba831c66d2db43210b00327c898fb213fbf597fc7beef0ee4c6e00bf33da88fc2d5a79147930aa72506ca6351e003826f142929670a0e6e7027b70a8546d22ffc2e1b21385c26c9264d2c6dfc5ac42aed53380d139d95b3df650a73548baf63de766a0abb3c77b2a881c2c92e47edaee692722c851482353ba2bfe8a14cf10364a81a664bbc423001c24b8b70d0f89791c76c51a30654be30d192e819d6ef5218d69906245565a910f40e35855771202a106aa07032bbd1b819a4c116b8d2d0c81e376c085141ab532748774cdf8eeb9934b0bcb5e19b48a8391c0cb3c5c95a634ed8aa4ae3418acb5b9cca4f7763e373682e6ff3d6b2b8a3748f82ee5defb2fc78a5636f43172f6084c87814a1f0ab728cc702081a6439ec90befffa23631e28a4506cebde82bde9bef9a3f7b2c67915c67178f2e372532bca273eceea26619cd186b8c721c0c207eada7dd6cde0eb1ef57d4f7fee6ed17806f067aa72176fba0a637dc5a2c898a6113f9804bef90dae1b710b35131c471b28db77f523047d8432caab7b40c724933c9ebe0a15c9bebc431d67c49c100d4c4cc5d4becb3e42b6597f299cfc657e2a5fcb6fab3ad6faec6c44198c4a475817";
        // Rotations may carry high bits; each consuming sum is masked to uint64.
        assembly ("memory-safe") {
            function round(state, word, constant) {
                let e := mload(add(state, 128))
                let f := mload(add(state, 160))
                let g := mload(add(state, 192))
                let t1 := and(add(add(add(add(mload(add(state, 224)),
                    xor(xor(or(shr(14, e), shl(50, e)), or(shr(18, e), shl(46, e))), or(shr(41, e), shl(23, e)))),
                    xor(and(e, f), and(not(e), g))), constant), word), 0xffffffffffffffff)
                let a := mload(state)
                let b := mload(add(state, 32))
                let c := mload(add(state, 64))
                let t2 := add(xor(xor(or(shr(28, a), shl(36, a)), or(shr(34, a), shl(30, a))), or(shr(39, a), shl(25, a))),
                    xor(xor(and(a, b), and(a, c)), and(b, c)))
                mstore(add(state, 224), g)
                mstore(add(state, 192), f)
                mstore(add(state, 160), e)
                mstore(add(state, 128), and(add(mload(add(state, 96)), t1), 0xffffffffffffffff))
                mstore(add(state, 96), c)
                mstore(add(state, 64), b)
                mstore(add(state, 32), a)
                mstore(state, and(add(t1, t2), 0xffffffffffffffff))
            }
            let h := mload(0x40)
            let work := add(h, 256)
            let w := add(work, 256)
            mstore(0x40, add(w, 2560))
            mstore(h, 0x6a09e667f3bcc908)
            mstore(add(h, 32), 0xbb67ae8584caa73b)
            mstore(add(h, 64), 0x3c6ef372fe94f82b)
            mstore(add(h, 96), 0xa54ff53a5f1d36f1)
            mstore(add(h, 128), 0x510e527fade682d1)
            mstore(add(h, 160), 0x9b05688c2b3e6c1f)
            mstore(add(h, 192), 0x1f83d9abfb41bd6b)
            mstore(add(h, 224), 0x5be0cd19137e2179)
            for { let blockOffset := 0 } lt(blockOffset, mload(padded)) { blockOffset := add(blockOffset, 128) } {
                for { let i := 0 } lt(i, 16) { i := add(i, 1) } {
                    mstore(add(w, mul(i, 32)), shr(192, mload(add(add(padded, 32), add(blockOffset, mul(i, 8))))))
                }
                for { let i := 16 } lt(i, 80) { i := add(i, 1) } {
                    let x := mload(add(w, mul(sub(i, 15), 32)))
                    let y := mload(add(w, mul(sub(i, 2), 32)))
                    let s0 := xor(xor(or(shr(1, x), shl(63, x)), or(shr(8, x), shl(56, x))), shr(7, x))
                    let s1 := xor(xor(or(shr(19, y), shl(45, y)), or(shr(61, y), shl(3, y))), shr(6, y))
                    mstore(add(w, mul(i, 32)), and(add(add(add(s0, s1),
                        mload(add(w, mul(sub(i, 16), 32)))), mload(add(w, mul(sub(i, 7), 32)))), 0xffffffffffffffff))
                }
                for { let i := 0 } lt(i, 256) { i := add(i, 32) } { mstore(add(work, i), mload(add(h, i))) }
                for { let i := 0 } lt(i, 80) { i := add(i, 1) } {
                    round(work, mload(add(w, mul(i, 32))), shr(192, mload(add(add(constants, 32), mul(i, 8)))))
                }
                for { let i := 0 } lt(i, 256) { i := add(i, 32) } {
                    mstore(add(h, i), and(add(mload(add(h, i)), mload(add(work, i))), 0xffffffffffffffff))
                }
            }
            high := or(or(shl(192, mload(h)), shl(128, mload(add(h, 32)))), or(shl(64, mload(add(h, 64))), mload(add(h, 96))))
            low := or(or(shl(192, mload(add(h, 128))), shl(128, mload(add(h, 160)))), or(shl(64, mload(add(h, 192))), mload(add(h, 224))))
        }
    }
}

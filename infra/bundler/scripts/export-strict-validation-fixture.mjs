import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { encodeAbiParameters, encodeErrorResult, encodeFunctionResult, toFunctionSelector, toHex, zeroAddress } from 'viem';
import { entryPoint07Abi } from 'viem/account-abstraction';
import { pimlicoSimulationsAbi } from '../node_modules/@pimlico/alto/esm/types/contracts/PimlicoSimulations.js';

// Deliberately synthetic parser inputs. These addresses and return values are
// constructed here; this fixture does not represent a wallet or chain capture.
const pin = JSON.parse(readFileSync(new URL('../upstream.json', import.meta.url), 'utf8'));
const address = (index) => toHex(BigInt(0x1000 + index), { size: 20 });
const [entryPoint, simulation, pimlico, sender, factory, creator, implementation, validator, table] = Array.from({ length: 9 }, (_, index) => address(index + 1));
const word = (value) => toHex(BigInt(value), { size: 32 });
const unstaked = { stake: 0n, unstakeDelaySec: 0n };
const validation = {
  returnInfo: { preOpGas: 420000n, prefund: 800000000000000n, accountValidationData: ((1n << 48n) - 1n) << 160n, paymasterValidationData: 0n, paymasterContext: '0x' },
  senderInfo: unstaked, factoryInfo: unstaked, paymasterInfo: unstaked,
  aggregatorInfo: { aggregator: zeroAddress, stakeInfo: unstaked },
};
const output = encodeFunctionResult({ abi: pimlicoSimulationsAbi, functionName: 'simulateValidation', result: validation });
const createSender = toFunctionSelector('createSender(bytes)');
const validateUserOp = toFunctionSelector('validateUserOp((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes),bytes32,uint256)');
const call = (from, to, method, type = 'CALL') => ({ from, to, method, type, gas: 500000, value: '0' });
const returned = (data = '0x', type = 'RETURN') => ({ type, data, gasUsed: 10000 });
const fixture = {
  kind: 'generated-strict-validation-parser-fixture', testData: true,
  provenance: { generator: 'infra/bundler/scripts/export-strict-validation-fixture.mjs', package: pin.package, version: pin.version, commit: pin.commit, simulationAbiSha256: createHash('sha256').update(JSON.stringify(pimlicoSimulationsAbi)).digest('hex'), publicTransactions: 0, walletSignatures: 0, executionEvidence: false },
  entryPoint, simulation, pimlico,
  contracts: { factory, creator, implementation, validator, table },
  operation: { sender, nonce: '0', callData: '0x12345678', factory, factoryData: '0xabcdef01', paymaster: null, verificationGasLimit: '500000', callGasLimit: '250000', preVerificationGas: '100000', maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000000', signature: '0x11223344' },
  trace: {
    calls: [
      call(pimlico, entryPoint, toFunctionSelector('delegateAndRevert(address,bytes)')),
      call(entryPoint, simulation, toFunctionSelector('simulateValidation((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes))'), 'DELEGATECALL'),
      call(entryPoint, creator, createSender), call(creator, factory, '0xabcdef01'),
      call(factory, sender, '0x60006000', 'CREATE2'), returned('0x60006000'),
      returned(encodeAbiParameters([{ type: 'address' }], [sender])), returned(encodeAbiParameters([{ type: 'address' }], [sender])),
      call(entryPoint, sender, validateUserOp), call(sender, implementation, validateUserOp, 'DELEGATECALL'),
      call(sender, validator, '0x97003203'), returned(word(0)), returned(word(0)), returned(word(0)),
      returned(output), returned(encodeErrorResult({ abi: entryPoint07Abi, errorName: 'DelegateAndRevert', args: [true, output] }), 'REVERT'),
    ],
    callsFromEntryPoint: [
      { topLevelTargetAddress: creator, topLevelMethodSig: createSender, opcodes: { CREATE2: 1, CALL: 1, SSTORE: 1 }, access: { [sender]: { reads: { [word(1)]: word(0) }, writes: { [word(1)]: 1 } } }, contractSize: { [sender]: { contractSize: 0, opcode: 'EXTCODESIZE' }, [factory]: { contractSize: 512, opcode: 'CALL' }, [implementation]: { contractSize: 1024, opcode: 'DELEGATECALL' } }, extCodeAccessInfo: { [sender]: 'JUMP' } },
      { topLevelTargetAddress: sender, topLevelMethodSig: validateUserOp, opcodes: { CALL: 1, DELEGATECALL: 1, STATICCALL: 1, SLOAD: 1, SSTORE: 1, EXTCODECOPY: 1 }, access: { [sender]: { reads: { [word(1)]: word(9) }, writes: { [word(2)]: 1 } } }, contractSize: { [validator]: { contractSize: 4096, opcode: 'CALL' }, [implementation]: { contractSize: 1024, opcode: 'DELEGATECALL' }, [table]: { contractSize: 8192, opcode: 'EXTCODESIZE' } }, extCodeAccessInfo: { [table]: 'PUSH1' } },
    ],
    keccak: [encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [sender, 7n])], logs: [], debug: [], error: null, output,
  },
};
const target = new URL('../tests/fixtures/strict-validation.json', import.meta.url);
const encoded = JSON.stringify(fixture, null, 2) + '\n';
if (process.argv.includes('--check')) assert.equal(readFileSync(target, 'utf8'), encoded, 'Regenerate the deterministic strict parser fixture');
else writeFileSync(target, encoded);
console.log(JSON.stringify({ fixture: 'infra/bundler/tests/fixtures/strict-validation.json', generatedTestData: true, sourceAbi: fixture.provenance.simulationAbiSha256, checked: process.argv.includes('--check') }));

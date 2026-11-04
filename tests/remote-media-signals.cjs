const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const ts = createRequire(path.resolve('package.json'))('typescript');
const moduleValue = { exports: {} };
vm.runInNewContext(ts.transpileModule(
  fs.readFileSync('src/lib/remote-media-signals.ts', 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText, { module: moduleValue, exports: moduleValue.exports });
const { createRemoteMediaSignals } = moduleValue.exports;
const answer = { type: 'answer', sdp: 'synthetic-test-description' };
const candidate = (name) => ({ candidate: name });
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

async function main() {
  let calls = [];
  let active = true;
  let peer = {
    setRemoteDescription: async () => { calls.push('answer'); },
    addIceCandidate: async c => { calls.push(c.candidate); },
  };
  let receiver = createRemoteMediaSignals(peer, () => active);
  receiver.expectAnswer();
  await receiver.ice(candidate('early-1'));
  await receiver.ice(candidate('early-2'));
  assert.deepEqual(calls, [], 'ICE must wait for the answer');
  await receiver.answer(answer);
  assert.deepEqual(calls, ['answer', 'early-1', 'early-2']);
  await receiver.ice(candidate('late'));
  assert.equal(calls.at(-1), 'late');

  // An answer callback can still be awaiting WebRTC when realtime delivers ICE.
  const gate = deferred();
  calls = [];
  receiver = createRemoteMediaSignals({
    ...peer,
    setRemoteDescription: async () => {
      calls.push('answer-start');
      await gate.promise;
      calls.push('answer-end');
    },
  }, () => active);
  const applying = receiver.answer(answer);
  const concurrentIce = receiver.ice(candidate('concurrent'));
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(calls, ['answer-start']);
  gate.resolve();
  await Promise.all([applying, concurrentIce]);
  assert.deepEqual(calls, ['answer-start', 'answer-end', 'concurrent']);

  // One invalid early candidate must not discard the remaining good candidates.
  calls = [];
  receiver = createRemoteMediaSignals({
    ...peer,
    addIceCandidate: async c => {
      if (c.candidate === 'bad') throw new Error('synthetic candidate error');
      calls.push(c.candidate);
    },
  }, () => active);
  await receiver.ice(candidate('bad'));
  await receiver.ice(candidate('good'));
  await assert.rejects(receiver.answer(answer), /synthetic candidate error/);
  await receiver.ice(candidate('later'));
  assert.deepEqual(calls, ['answer', 'good', 'later']);

  // A failed answer does not open the candidate gate.
  let rejectAnswer = true;
  calls = [];
  receiver = createRemoteMediaSignals({
    ...peer,
    setRemoteDescription: async () => {
      if (rejectAnswer) throw new Error('synthetic description error');
      calls.push('answer');
    },
  }, () => active);
  await receiver.ice(candidate('held'));
  await assert.rejects(receiver.answer(answer), /synthetic description error/);
  assert.deepEqual(calls, []);
  rejectAnswer = false;
  await receiver.answer(answer);
  assert.deepEqual(calls, ['answer', 'held']);

  // Renegotiation and teardown discard candidates from the previous lifetime.
  calls = [];
  receiver = createRemoteMediaSignals(peer, () => active);
  const obsolete = receiver.ice(candidate('obsolete'));
  receiver.expectAnswer();
  await obsolete;
  await receiver.ice(candidate('current'));
  await receiver.answer(answer);
  assert.deepEqual(calls, ['answer', 'current']);
  receiver.close();
  await receiver.ice(candidate('after-close'));
  await receiver.answer(answer);
  assert.deepEqual(calls, ['answer', 'current']);

  const closeGate = deferred();
  calls = [];
  receiver = createRemoteMediaSignals({
    ...peer, setRemoteDescription: async () => { await closeGate.promise; },
  }, () => active);
  await receiver.ice(candidate('never-apply'));
  const closingAnswer = receiver.answer(answer);
  await Promise.resolve();
  receiver.close();
  closeGate.resolve();
  await closingAnswer;
  assert.deepEqual(calls, []);

  receiver = createRemoteMediaSignals(peer, () => active);
  for (let i = 0; i < 256; i++) await receiver.ice(candidate(`bounded-${i}`));
  await assert.rejects(receiver.ice(candidate('overflow')), /queue limit/);
  receiver.close();
  active = false;
  calls = [];
  receiver = createRemoteMediaSignals(peer, () => active);
  await receiver.answer(answer);
  await receiver.ice(candidate('inactive'));
  assert.deepEqual(calls, []);

  const live = fs.readFileSync('src/lib/webrtc-live.ts', 'utf8');
  assert(live.includes('await remoteMedia.answer('));
  assert(live.includes('await remoteMedia.ice('));
  assert(!live.includes('row.id <= lastSeen'), 'newer ICE must not discard a reordered answer');
  assert(live.includes('isCurrentPeerSignal(peerId, !!options.videoOnly, row.payload)'));
  console.log('Remote media signaling: early/concurrent ICE, errors, lifetime, bounds and peer guards passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });

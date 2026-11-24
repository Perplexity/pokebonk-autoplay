import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import dns from 'node:dns';
import dgram from 'node:dgram';
import { connect as namedConnect } from 'node:net';
import { resolve } from 'node:path';
import { GUARD_ERROR, assertOfflineConfig, installNetworkGuard, networkGuard, offlineConfigProblems } from '../../src/sim/guard.ts';
import { Sim } from '../../src/sim/env.ts';

// The offline guard. This file runs in its own process (node --test starts one per file), so installing the guard
// here does not touch the other tests. Only reserved addresses are used (TEST-NET-1, the .invalid TLD).

const MIRROR = resolve(import.meta.dirname, '..', '..', 'mirror');
const HOST = '192.0.2.1';
const nativeFetch = globalThis.fetch;
const guard = installNetworkGuard();
const refused = (fn: () => unknown) => assert.throws(fn, (e: any) => e.code === GUARD_ERROR && /network is disabled/.test(e.message));

test('installing twice returns the same guard', () => {
  assert.equal(installNetworkGuard(), guard);
  assert.equal(networkGuard(), guard);
  assert.ok(guard.primitives.length >= 40, `only ${guard.primitives.length} primitives replaced`);
  for (const p of ['net.Socket.connect', 'net.connect', 'tls.connect', 'http.request', 'https.get', 'http2.connect', 'dns.lookup', 'dns.promises.lookup', 'dgram.createSocket', 'globalThis.fetch', 'globalThis.WebSocket'])
    assert.ok(guard.primitives.includes(p), `${p} is not guarded`);
});

test('the startup self-test finds every primitive blocked', async () => {
  const before = guard.attempts.length;
  const r = await guard.selfTest();
  assert.deepEqual(r.probes.filter((p) => !p.blocked), []);
  assert.equal(r.ok, true);
  assert.ok(r.probes.length >= 20);
  for (const name of ['net.connect', 'tls.connect', 'http.request', 'https.get', 'http2.connect', 'dns.lookup', 'dgram.createSocket', 'Node built-in fetch (original function)'])
    assert.ok(r.probes.some((p) => p.name === name), `no probe for ${name}`);
  assert.equal(guard.attempts.length, before, 'self-test probes are not logged as attempts');
});

test('net, tls, http, https, http2, dns and dgram record and throw', async () => {
  const before = guard.attempts.length;
  refused(() => net.connect(80, HOST));
  refused(() => namedConnect(80, HOST)); // a named import bound before the guard was installed
  refused(() => net.createConnection({ host: HOST, port: 80 }));
  refused(() => new net.Socket().connect(80, HOST));
  refused(() => net.createServer().listen(0));
  refused(() => tls.connect(443, HOST));
  refused(() => http.request(`http://${HOST}/x`));
  refused(() => http.get({ host: HOST, port: 8080, path: '/' }));
  refused(() => https.request(`https://${HOST}/`));
  refused(() => https.get(new URL(`https://${HOST}/y`)));
  refused(() => http2.connect(`https://${HOST}`));
  refused(() => dns.lookup('example.invalid', () => undefined));
  refused(() => dns.resolve4('example.invalid', () => undefined));
  refused(() => new dns.Resolver().resolve('example.invalid', () => undefined));
  await assert.rejects(dns.promises.lookup('example.invalid'), (e: any) => e.code === GUARD_ERROR);
  await assert.rejects(dns.promises.resolve('example.invalid'), (e: any) => e.code === GUARD_ERROR);
  refused(() => dgram.createSocket('udp4'));
  const made = guard.attempts.slice(before);
  assert.equal(made.length, 17);
  assert.deepEqual(made[0], { kind: 'net.connect', target: `80 ${HOST}` });
  assert.ok(made.some((a) => a.kind === 'https.get' && a.target.includes(`https://${HOST}/y`)));
  assert.ok(made.some((a) => a.kind === 'dns.promises.lookup' && a.target === 'example.invalid'));
});

test('fetch and WebSocket record and throw, including Node\'s original fetch', async () => {
  const before = guard.attempts.length;
  await assert.rejects((globalThis as any).fetch(`http://${HOST}/`), (e: any) => e.code === GUARD_ERROR);
  refused(() => new (globalThis as any).WebSocket(`ws://${HOST}/`));
  // The function Node shipped, captured before the guard: its HTTP client ends in the guarded socket connect.
  await assert.rejects(nativeFetch(`http://${HOST}/`), (e: any) => e.cause?.code === GUARD_ERROR);
  const made = guard.attempts.slice(before);
  assert.ok(made.some((a) => a.kind === 'globalThis.fetch'));
  assert.ok(made.some((a) => a.kind === 'globalThis.WebSocket'));
  assert.ok(made.length >= 3, 'the original fetch was stopped at the socket level and recorded');
});

test('a configuration that names a remote game endpoint is refused', () => {
  const ok = { pageOrigin: 'http://localhost:8080', apiTarget: 'in-process-mock', mirrorDir: MIRROR };
  assert.deepEqual(offlineConfigProblems(ok), []);
  assert.doesNotThrow(() => assertOfflineConfig(ok));
  assert.match(offlineConfigProblems({ ...ok, apiTarget: 'https://api.pokebonk.com' })[0], /names a remote game endpoint/);
  assert.match(offlineConfigProblems({ ...ok, apiTarget: 'http://127.0.0.1:8080/__api' })[0], /only talks to the in-process mock/);
  assert.match(offlineConfigProblems({ ...ok, pageOrigin: 'https://pokebonk.com' })[0], /not a loopback origin/);
  assert.match(offlineConfigProblems({ ...ok, mirrorDir: resolve(MIRROR, 'nope') })[0], /no local game copy/);
  assert.throws(() => assertOfflineConfig({ ...ok, apiTarget: 'https://api.pokebonk.com' }), /refusing to start/);
});

test('the game process refuses to start with a remote endpoint, before anything is loaded', async () => {
  await assert.rejects(Sim.boot({ seed: 1, apiTarget: 'https://api.pokebonk.com' }), /refusing to start.*remote game endpoint/);
  assert.equal((globalThis as any).__pb, undefined, 'no game code was loaded');
  assert.equal((globalThis as any).document, undefined, 'no browser shim was installed');
});

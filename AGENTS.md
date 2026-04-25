# Socket.IO Worker

## Overview

Generic Socket.IO proxy that keeps the real client inside a classic Worker.  
Transport, heartbeat, ping/pong, and reconnect timers stay off the main
thread.  

## Work Rules

- You **MUST** write tests first.  
- You **MUST** treat the test suite as slightly more important than source.  
  Keep it pristine, uniform, high-signal, and free of junk tests.  
  Do not tolerate deviations from this.  
- You **MUST** match existing patterns and idioms down to the last detail.  
- You **MUST** surface errors properly.  
  Never swallow an error.  
- You **MUST** double-check and review your work.  
  No dead files, inconsistencies, or drift should remain.  

## Project Scope

- Keep this package generic.  
  No app-specific events, auth schemes, routes, or reconnect policy.  
- Pass the Socket.IO client URL explicitly as `lib`.  
  Page script tags are not inspected.  
- For Polymer element decisions, match Polymer 1.x idioms.  

```html
<!-- ✅ Polymer-style boolean attribute -->
<socketio-worker auto></socketio-worker>

<!-- ❌ Avoid custom long-form boolean aliases -->
<socketio-worker auto-connect></socketio-worker>
```

- For code and domain terms, prefer Socket.IO terminology where possible.  
  Do not thrash terminology unnecessarily.  

```js
// ✅ Keep Socket.IO names
proxy.on('connect_error', handler)
await proxy.managerCall('reconnectionAttempts', [3])

// ❌ Avoid renaming established concepts
proxy.on('connection_failed', handler)
await proxy.managerCall('retryLimit', [3])
```

## Runtime Contract

- Payloads, call args, and method results follow Socket.IO JSON serialization.  
  `undefined` keeps Socket.IO parity.  
  Array slots become `null`; object fields are omitted.  
- Callback acks, binary data, functions, DOM nodes, class instances, symbols,
  and cycles do not cross the worker boundary.  
  Callback acks would need an internal ack id so the callback stays on the main
  thread.  
- Direct proxy mutation is local only.  
  Use `set(path, value)` or `set(object)` for worker-owned mutation.  
- Timed-out `connect()` calls must not leave a late visible connection.  
- Bridge-owned listeners must survive listener-mutating methods.  
  Examples: `offAny()` and `removeAllListeners()`.  

## Message Channels

```text
call   -> RPC request/response by id
cancel -> best-effort abort for timed-out connect()
update -> worker-owned state patch
socket -> forwarded server event
```

`WorkerMessage` subclasses are local builders only.  
Only their plain `.toJSON()` payloads cross `postMessage()`.  

## Event Naming

```text
connect / disconnect / connect_error -> preserve Socket.IO names
proxy:*                              -> bridge/meta events
server:event                         -> forwarded unchanged
```

> [!IMPORTANT]
> `proxy:*` events are bridge-internal. Do not document or stabilize.
> May be renamed or removed without notice.

## Error Taxonomy

```text
TypeError   -> invalid shape
RangeError  -> invalid value
SyntaxError -> native JSON parse failure
Error       -> runtime/component failure
```

## Code Guidelines

- You **MUST** keep code direct and close to the Socket.IO concepts.  
- You **MUST** avoid intermediates unless they remove real complexity.  
- You **MUST** use concise names that carry their actual role.  
- You **SHOULD** prefer functional array methods when they stay readable.  

✅ **Good Way**

```js
this._listeners[event] = listeners.filter(listener => listener !== handler)
```

❌ **Bad Way**

```js
const nextListeners = []

for (const listener of listeners) {
  if (listener !== handler)
    nextListeners.push(listener)
}

this._listeners[event] = nextListeners
```

✅ **Good Way**

```js
return callMethod(socket.io, message.method, message.args)
```

❌ **Bad Way**

```js
const manager = socket.io
const method = message.method
const args = message.args

return callMethod(manager, method, args)
```

## Testing Guidelines

- You **MUST** run `node --test` with `--test-concurrency=1`.  
  Polymer/jsdom fixtures load HTML imports in one process and race under file
  concurrency.  
- You **MUST** nest tests as `subject -> #method -> context -> behavior`.  
- You **MUST** put shared **arrange + act** in the nearest owning
  `t.beforeEach()`.  
- You **MUST** keep leaf `t.test()` blocks assertion-focused.  
- You **MUST** attach fixtures/results to `t`, not outer variables.  
- You **MUST** use `partialDeepStrictEqual()` for snapshots and payload-shaped
  values.  

Test fixture roles:

```text
test/main.test.js      -> real Socket.IO server flows
test/proxy.test.js     -> proxy / worker bridge mechanics
test/element.test.js   -> Polymer wrapper behavior
test/utils/index.js    -> core Fixture, server helper, shared exports
test/utils/jsdom.js    -> Polymer/jsdom fixture
test/utils/socket.io.js -> vendored Socket.IO browser client for VM/jsdom
test/utils/worker.js   -> shared VM WorkerHost
```

> [!TIP]
> - jsdom + Polymer boot is slow.
> - The fixture caches the DOM; each `fixture()` recreates only the element.
> - Per-element `detached()` terminates its own worker — safe across tests.

### Test Utilities

- You **MUST** use existing `#test/utils` fixtures before adding a helper.  
- You **MUST NOT** add tests that target `test/utils` directly.  
  Cover utility behavior through the owning feature tests.  
- You **MUST** keep behavior-specific setup inline until it is repeated.  
- You **MUST** keep helpers generic.  
  Tests own the behavior claim.  
- You **MUST NOT** pass `t` into helper functions.  

✅ **Good Way**

```js
import { test } from 'node:test'
import { Fixture, once, plain, server } from '#test/utils'

test('SocketIOWorker', async t => {
  t.beforeEach(async t => {
    t.server = await server()
    t.fixture = new Fixture()
    t.Proxy = t.fixture.load()
    t.proxy = new t.Proxy({ src, lib })
  })

  t.afterEach(async t => {
    await t.proxy?.disconnect().catch(() => null)
    t.proxy?.terminate()
    t.fixture.close()
    await t.server?.close()
  })

  await t.test('#connect', async t => {
    const [[socket], snapshot] = await Promise.all([
      once(t.server.io, 'connection'),
      t.proxy.connect(t.server.url)
    ])

    t.assert.partialDeepStrictEqual(plain(snapshot), { connected: true })
  })
})
```

❌ **Bad Way**

```js
// hides setup, action, and assertion boundaries
t.context = await setupHappyConnectedSocket(t)

// domain-specific one-off helper
const socket = await connectAdminRoomWithBlueQuery()
```

✅ **Good Way**

```js
import { test } from 'node:test'
import { Fixture, plain, server } from '#test/utils'

test('SocketIOWorker', async t => {
  t.beforeEach(t => {
    t.fixture = new Fixture()
    t.Proxy = t.fixture.load()
  })

  t.afterEach(async t => {
    await t.proxy?.disconnect().catch(() => null)
    t.proxy?.terminate()
    t.fixture.close()
    await t.server?.close()
  })

  await t.test('#connect', async t => {
    t.beforeEach(async t => {
      t.server = await server()
      t.proxy = new t.Proxy({ src, lib })
    })

    await t.test('with valid auth', async t => {
      t.beforeEach(async t => {
        t.server.io.use((socket, next) =>
          socket.handshake.auth.token === 'ok'
            ? next()
            : next(new Error('forbidden'))
        )

        t.snapshot = plain(await t.proxy
          .set({ auth: { token: 'ok' } })
          .connect(t.server.url))
      })

      await t.test('returns connected snapshot', t => {
        t.assert.partialDeepStrictEqual(t.snapshot, {
          connected: true,
          transport: 'websocket'
        })
      })

      await t.test('updates proxy state', t => {
        t.assert.partialDeepStrictEqual(t.proxy, {
          connected: true
        })
      })
    })
  })
})
```

Shape:

```text
subject
└── #method
    └── context
        ├── beforeEach: arrange + act
        ├── behavior assertion
        └── behavior assertion
```

❌ **Bad Way**

```js
let proxy
let snapshot

test('connect works', async t => {
  const fixture = new Fixture()
  const Proxy = fixture.load()
  const s = await server()

  proxy = new Proxy({ src, lib })
  s.io.use((socket, next) => next())

  snapshot = await proxy.connect(s.url)

  t.assert.strictEqual(snapshot.connected, true)
  t.assert.strictEqual(proxy.connected, true)
  t.assert.strictEqual(snapshot.transport, 'websocket')

  await proxy.disconnect()
  proxy.terminate()
  await s.close()
  fixture.close()
})
```

Problems:

- Flat name hides subject/method/context.  
- Outer variables leak state.  
- Arrange, act, assertions, and teardown are mixed.  
- Multiple behavior claims are packed into one test.  
- Snapshot-shaped values use scalar assertion sprawl.  

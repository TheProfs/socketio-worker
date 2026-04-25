import { test } from 'node:test'
import { Fixture, once, plain, server } from '#test/utils'

test('SocketIOWorker flows', async t => {
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

  await t.test('#connect via handshake', async t => {
    t.beforeEach(async t => {
      t.server = await server()
      t.proxy = new t.Proxy({
        src: t.fixture.script,
        lib: t.fixture.library,
        options: {
          autoConnect: false,
          transports: ['websocket'],
          reconnection: false
        }
      })
    })

    await t.test('when middleware reads matching auth', async t => {
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
          disconnected: false,
          transport: 'websocket'
        })
      })
    })

    await t.test('when middleware reads query alias', async t => {
      t.beforeEach(async t => {
        t.received = []
        t.server.io.use((socket, next) => {
          t.received.push(socket.handshake.query.room)
          next()
        })
        await t.proxy.set('query.room', 'blue').connect(t.server.url)
      })

      await t.test('forwards alias to handshake.query.room', t => {
        t.assert.strictEqual(t.received[0], 'blue')
      })
    })

    await t.test('on a namespace', async t => {
      t.beforeEach(t => {
        t.server.io.of('/admin').use((socket, next) =>
          socket.handshake.auth.role === 'admin'
            ? next()
            : next(new Error('admins only'))
        )
      })

      await t.test('when role matches', async t => {
        t.beforeEach(async t => {
          t.snapshot = plain(await t.proxy
            .set({ auth: { role: 'admin' } })
            .connect(`${t.server.url}/admin`))
        })

        await t.test('returns connected snapshot', t => {
          t.assert.partialDeepStrictEqual(t.snapshot, { connected: true })
        })
      })

      await t.test('when role is missing', async t => {
        t.beforeEach(async t => {
          t.failure = await t.proxy
            .connect(`${t.server.url}/admin`)
            .catch(error => error)
        })

        await t.test('rejects with the namespace middleware error', t => {
          t.assert.match(t.failure.message, /admins only/)
        })
      })
    })
  })

  await t.test('server-initiated disconnect', async t => {
    t.beforeEach(async t => {
      t.server = await server()
      t.proxy = new t.Proxy({
        src: t.fixture.script,
        lib: t.fixture.library,
        options: {
          autoConnect: false,
          transports: ['websocket'],
          reconnection: false
        }
      })

      const [[socket]] = await Promise.all([
        once(t.server.io, 'connection'),
        t.proxy.connect(t.server.url)
      ])

      t.socket = socket
      t.disconnects = []
      t.proxy.on('disconnect', (patch, message) => {
        t.disconnects.push({
          patch: plain(patch),
          reason: plain(message?.value)
        })
      })
    })

    await t.test('after socket.disconnect()', async t => {
      t.beforeEach(async t => {
        const arrived = new Promise(resolve =>
          t.proxy.on('disconnect', () => resolve())
        )
        t.socket.disconnect()
        await arrived
      })

      await t.test('reflects disconnected', t => {
        t.assert.partialDeepStrictEqual(t.proxy, {
          connected: false,
          disconnected: true,
          active: false
        })
      })

      await t.test('emits a single disconnect event', t => {
        t.assert.strictEqual(t.disconnects.length, 1)
      })

      await t.test('carries a reason string', t => {
        t.assert.match(t.disconnects[0].reason, /\w+/)
      })
    })

    await t.test('after io.disconnectSockets()', async t => {
      t.beforeEach(async t => {
        const arrived = new Promise(resolve =>
          t.proxy.on('disconnect', () => resolve())
        )
        t.server.io.disconnectSockets()
        await arrived
      })

      await t.test('reflects disconnected', t => {
        t.assert.partialDeepStrictEqual(t.proxy, {
          connected: false,
          disconnected: true,
          active: false
        })
      })
    })

    await t.test('after io.close()', async t => {
      t.beforeEach(async t => {
        const arrived = new Promise(resolve =>
          t.proxy.on('disconnect', () => resolve())
        )
        await new Promise(resolve => t.server.io.close(resolve))
        t.server = null
        await arrived
      })

      await t.test('reflects disconnected', t => {
        t.assert.partialDeepStrictEqual(t.proxy, {
          connected: false,
          disconnected: true
        })
      })
    })
  })

  await t.test('reconnection cycle', async t => {
    t.beforeEach(async t => {
      t.server = await server()
      t.proxy = new t.Proxy({
        src: t.fixture.script,
        lib: t.fixture.library,
        options: {
          autoConnect: false,
          transports: ['websocket'],
          reconnection: true,
          reconnectionDelay: 50,
          reconnectionDelayMax: 50,
          randomizationFactor: 0,
          reconnectionAttempts: 3,
          timeout: 200
        }
      })
    })

    await t.test('when transport drops and server stays available', async t => {
      t.beforeEach(async t => {
        const events = []
        for (const name of ['disconnect', 'proxy:reconnect_attempt', 'connect'])
          t.proxy.on(name, () => events.push(name))
        t.events = events

        const [[socket]] = await Promise.all([
          once(t.server.io, 'connection'),
          t.proxy.connect(t.server.url)
        ])

        let connects = 0
        const reconnected = new Promise(resolve =>
          t.proxy.on('connect', () => { if (++connects === 1) resolve() })
        )
        socket.conn.close()
        await reconnected
      })

      await t.test('returns to connected state', t => {
        t.assert.partialDeepStrictEqual(t.proxy, {
          connected: true,
          reconnecting: false,
          active: true
        })
      })

      await t.test('observes a disconnect before the reconnect attempt', t => {
        t.assert.ok(
          t.events.indexOf('disconnect') <
          t.events.indexOf('proxy:reconnect_attempt')
        )
      })

      await t.test('observes reconnect attempt before second connect', t => {
        const reconnectIdx = t.events.indexOf('proxy:reconnect_attempt')
        const lastConnectIdx = t.events.lastIndexOf('connect')
        t.assert.ok(reconnectIdx < lastConnectIdx)
      })
    })

    await t.test('when server becomes unreachable', async t => {
      t.beforeEach(async t => {
        const exhausted = new Promise(resolve =>
          t.proxy.on('proxy:reconnect_failed', resolve)
        )

        await Promise.all([
          once(t.server.io, 'connection'),
          t.proxy.connect(t.server.url)
        ])

        await t.server.close()
        t.server = null
        await exhausted
      })

      await t.test('reports disconnected and stops reconnecting', t => {
        t.assert.partialDeepStrictEqual(t.proxy, {
          connected: false,
          reconnecting: false
        })
      })

      await t.test('after closing the proxy', async t => {
        t.beforeEach(async t => {
          t.closed = await t.proxy.close()
        })

        await t.test('returns the proxy', t => {
          t.assert.strictEqual(t.closed, t.proxy)
        })

        await t.test('rejects future calls', async t => {
          await t.assert.rejects(
            () => t.proxy.emit('client:event'),
            { message: /terminated/ }
          )
        })
      })
    })
  })

  await t.test('connection state recovery', async t => {
    t.beforeEach(async t => {
      t.server = await server({
        connectionStateRecovery: {
          maxDisconnectionDuration: 60_000,
          skipMiddlewares: true
        }
      })
      t.proxy = new t.Proxy({
        src: t.fixture.script,
        lib: t.fixture.library,
        options: {
          autoConnect: false,
          transports: ['websocket'],
          reconnection: true,
          reconnectionDelay: 50,
          reconnectionDelayMax: 50,
          randomizationFactor: 0,
          timeout: 200
        }
      })
    })

    await t.test('within the disconnection window', async t => {
      t.beforeEach(async t => {
        const [[socket]] = await Promise.all([
          once(t.server.io, 'connection'),
          t.proxy.connect(t.server.url)
        ])

        const seeded = new Promise(resolve =>
          t.proxy.on('server:event', resolve)
        )
        socket.emit('server:event', { ok: true })
        await seeded

        let connects = 0
        const reconnected = new Promise(resolve =>
          t.proxy.on('connect', () => { if (++connects === 1) resolve() })
        )
        socket.conn.close()
        await reconnected
      })

      await t.test('reports recovered=true', t => {
        t.assert.strictEqual(t.proxy.recovered, true)
      })
    })
  })

  await t.test('server-driven traffic', async t => {
    t.beforeEach(async t => {
      t.server = await server()
      t.proxy = new t.Proxy({
        src: t.fixture.script,
        lib: t.fixture.library,
        options: {
          autoConnect: false,
          transports: ['websocket'],
          reconnection: false
        }
      })

      const [[socket]] = await Promise.all([
        once(t.server.io, 'connection'),
        t.proxy.connect(t.server.url)
      ])
      t.socket = socket
    })

    await t.test('via broadcast', async t => {
      await t.test('forwards io.emit', async t => {
        const received = new Promise(resolve =>
          t.proxy.on('news', payload => resolve(payload))
        )

        t.server.io.emit('news', { headline: 'hello' })

        t.assert.partialDeepStrictEqual(plain(await received), {
          headline: 'hello'
        })
      })
    })

    await t.test('via room scoping', async t => {
      t.beforeEach(t => t.socket.join('blue'))

      await t.test('delivers events to joined rooms', async t => {
        const received = new Promise(resolve =>
          t.proxy.on('room:msg', payload => resolve(payload))
        )

        t.server.io.to('blue').emit('room:msg', { id: 1 })

        t.assert.partialDeepStrictEqual(plain(await received), { id: 1 })
      })

      await t.test('skips events scoped to other rooms', async t => {
        const collected = []
        t.proxy.on('room:msg', payload => collected.push(payload))

        const witness = new Promise(resolve =>
          t.proxy.on('room:other', payload => resolve(payload))
        )

        t.server.io.to('red').emit('room:msg', { id: 2 })
        t.server.io.emit('room:other', { ok: true })

        await witness
        t.assert.deepStrictEqual(collected, [])
      })
    })
  })

  await t.test('concurrent proxies', async t => {
    t.beforeEach(async t => {
      t.server = await server()
      t.proxies = [0, 1].map(() => new t.Proxy({
        src: t.fixture.script,
        lib: t.fixture.library,
        options: {
          autoConnect: false,
          transports: ['websocket'],
          reconnection: false
        }
      }))
      await Promise.all(t.proxies.map(p => p.connect(t.server.url)))
    })

    t.afterEach(async t => {
      for (const proxy of t.proxies) {
        await proxy.disconnect().catch(() => null)
        proxy.terminate()
      }
    })

    await t.test('hold independent ids', t => {
      const [a, b] = t.proxies
      t.assert.notStrictEqual(a.id, null)
      t.assert.notStrictEqual(b.id, null)
      t.assert.notStrictEqual(a.id, b.id)
    })
  })
})

import { test } from 'node:test'
import { fixture, once, plain, server } from '#test/utils'

const html = `<!doctype html>
<html>
  <head>
    <script src="lib/webcomponents-lite.min.js"></script>
    <link rel="import" href="lib/polymer.html">
    <link rel="import" href="socketio-worker.html">
  </head>
  <body></body>
</html>`

const attrs = values => ({
  src: 'socketio-worker.js',
  lib: 'test/utils/socket.io.js',
  ...values
})

const json = value => JSON.stringify(value)

const mount = async values => {
  const f = await fixture(html)

  return {
    fixture: f,
    element: f.mount('socketio-worker', attrs(values))
  }
}

const changed = (element, property) =>
  new Promise(resolve =>
    element.addEventListener(`${property}-changed`, resolve, { once: true })
  )

const logEntry = element =>
  element.lastMessage ? JSON.parse(element.lastMessage) : null

const state = element => ({
  connected: element.connected,
  reconnecting: element.reconnecting,
  loading: element.loading,
  lastError: element.lastError
})

test('<socketio-worker>', { timeout: 180000 }, async t => {
  await t.test('default state', async t => {
    t.beforeEach(async t => {
      Object.assign(t, await mount())
    })

    t.afterEach(async t => {
      await t.fixture.close()
    })

    await t.test('exposes bindable disconnected state', t => {
      t.assert.partialDeepStrictEqual(state(t.element), {
        connected: false,
        reconnecting: false,
        loading: false,
        lastError: ''
      })
    })
  })

  await t.test('attached()', async t => {
    await t.test('without auto', async t => {
      t.beforeEach(async t => {
        Object.assign(t, await mount())
        t.ready = plain(await t.element.socket.ready)
      })

      t.afterEach(async t => {
        await t.fixture.close()
      })

      await t.test('initializes a disconnected socket', t => {
        t.assert.partialDeepStrictEqual(t.ready, {
          connected: false,
          disconnected: true
        })
      })
    })

    await t.test('with auto', { timeout: 30000 }, async t => {
      t.beforeEach(async t => {
        t.server = await server()
        Object.assign(t, await mount({
          auto: true,
          url: t.server.url
        }))

        t.entry = await t.fixture.waitFor(
          element => element.connected && logEntry(element),
          { message: 'expected auto connect log' }
        )
      })

      t.afterEach(async t => {
        await t.fixture.close()
        await t.server.close()
      })

      await t.test('updates bindable state', t => {
        t.assert.partialDeepStrictEqual(state(t.element), {
          connected: true,
          loading: false
        })
      })

      await t.test('logs the connection snapshot', t => {
        t.assert.partialDeepStrictEqual(t.entry, {
          type: 'connect',
          data: {
            connected: true,
            transport: 'websocket'
          }
        })
      })
    })
  })

  await t.test('#connect', { timeout: 90000 }, async t => {
    await t.test('with auth and query attributes', { timeout: 45000 }, async t => {
      t.beforeEach(async t => {
        t.server = await server()
        t.handshakes = []
        t.server.io.use((socket, next) => {
          t.handshakes.push({
            auth: plain(socket.handshake.auth),
            query: { room: socket.handshake.query.room }
          })
          next()
        })
        Object.assign(t, await mount({
          url: t.server.url,
          auth: json({ name: 'alice' }),
          query: json({ room: 'blue' })
        }))

        const connected = changed(t.element, 'connected')

        t.client = await t.element.connect()
        t.event = await connected
        t.entry = logEntry(t.element)
      })

      t.afterEach(async t => {
        await t.fixture.close()
        await t.server.close()
      })

      await t.test('returns the socket proxy', t => {
        t.assert.strictEqual(t.client, t.element.socket)
      })

      await t.test('updates bindable state', t => {
        t.assert.partialDeepStrictEqual(state(t.element), {
          connected: true,
          reconnecting: false,
          loading: false
        })
      })

      await t.test('notifies connected=true', t => {
        t.assert.strictEqual(t.event.detail.value, true)
      })

      await t.test('passes auth and query to Socket.IO', t => {
        t.assert.partialDeepStrictEqual(t.handshakes[0], {
          auth: { name: 'alice' },
          query: { room: 'blue' }
        })
      })

      await t.test('logs the connection snapshot', t => {
        t.assert.partialDeepStrictEqual(t.entry, {
          type: 'connect',
          data: {
            connected: true,
            transport: 'websocket'
          }
        })
      })
    })

    await t.test('while pending', async t => {
      t.beforeEach(async t => {
        t.server = await server()
        t.middleware = new Promise(resolve => {
          t.server.io.use((socket, next) => {
            t.release = next
            resolve()
          })
        })
        Object.assign(t, await mount({ url: t.server.url }))

        t.connecting = t.element.connect()
        await t.middleware
        await t.fixture.waitFor(
          element => element.loading,
          { message: 'expected loading=true' }
        )
      })

      t.afterEach(async t => {
        t.release?.()
        await t.connecting?.catch(() => null)
        await t.fixture.close()
        await t.server.close()
      })

      await t.test('sets loading=true', t => {
        t.assert.strictEqual(t.element.loading, true)
      })
    })

    await t.test('when middleware rejects', { timeout: 45000 }, async t => {
      t.beforeEach(async t => {
        t.server = await server()
        t.server.io.use((socket, next) =>
          next(new Error('forbidden'))
        )
        Object.assign(t, await mount({ url: t.server.url }))

        t.failure = await t.element.connect().catch(error => error)
      })

      t.afterEach(async t => {
        await t.fixture.close()
        await t.server.close()
      })

      await t.test('rejects with the middleware error', t => {
        t.assert.match(t.failure.message, /forbidden/)
      })

      await t.test('clears loading state', t => {
        t.assert.partialDeepStrictEqual(state(t.element), {
          connected: false,
          loading: false
        })
      })

      await t.test('logs the error', t => {
        t.assert.match(t.element.lastError, /forbidden/)
      })
    })

    await t.test('with invalid auth JSON', { timeout: 30000 }, async t => {
      t.beforeEach(async t => {
        Object.assign(t, await mount({
          auth: '{'
        }))

        t.failure = await t.element.connect().catch(error => error)
      })

      t.afterEach(async t => {
        await t.fixture.close()
      })

      await t.test('rejects with a SyntaxError', t => {
        t.assert.strictEqual(t.failure.name, 'SyntaxError')
      })

      await t.test('clears loading state', t => {
        t.assert.strictEqual(t.element.loading, false)
      })

      await t.test('logs the parse error', t => {
        t.assert.match(t.element.lastError, /message/)
      })
    })
  })

  await t.test('#disconnect', { timeout: 30000 }, async t => {
    await t.test('when connected', { timeout: 30000 }, async t => {
      t.beforeEach(async t => {
        t.server = await server()
        Object.assign(t, await mount({ url: t.server.url }))

        const [[socket]] = await Promise.all([
          once(t.server.io, 'connection'),
          t.element.connect()
        ])
        const disconnected = changed(t.element, 'connected')

        t.serverDisconnect = once(socket, 'disconnect')
        t.result = await t.element.disconnect()
        t.event = await disconnected
        t.serverReason = (await t.serverDisconnect)[0]
      })

      t.afterEach(async t => {
        await t.fixture.close()
        await t.server.close()
      })

      await t.test('returns the element', t => {
        t.assert.strictEqual(t.result, t.element)
      })

      await t.test('updates bindable state', t => {
        t.assert.partialDeepStrictEqual(state(t.element), {
          connected: false,
          reconnecting: false,
          loading: false
        })
      })

      await t.test('notifies connected=false', t => {
        t.assert.strictEqual(t.event.detail.value, false)
      })

      await t.test('disconnects the server socket', t => {
        t.assert.strictEqual(t.serverReason, 'client namespace disconnect')
      })
    })

    await t.test('when the socket rejects', { timeout: 30000 }, async t => {
      t.beforeEach(async t => {
        Object.assign(t, await mount())

        t.element.socket.terminate()
        t.failure = await t.element.disconnect().catch(error => error)
      })

      t.afterEach(async t => {
        await t.fixture.close()
      })

      await t.test('rejects with the socket error', t => {
        t.assert.match(t.failure.message, /terminated/)
      })

      await t.test('clears loading state', t => {
        t.assert.partialDeepStrictEqual(state(t.element), {
          loading: false
        })
      })

      await t.test('logs the error', t => {
        t.assert.match(t.element.lastError, /terminated/)
      })
    })
  })

  await t.test('worker updates', async t => {
    await t.test('when the server disconnects the socket', { timeout: 30000 }, async t => {
      t.beforeEach(async t => {
        t.server = await server()
        Object.assign(t, await mount({ url: t.server.url }))

        const [[socket]] = await Promise.all([
          once(t.server.io, 'connection'),
          t.element.connect()
        ])
        const disconnected = changed(t.element, 'connected')

        socket.disconnect()
        t.event = await disconnected
      })

      t.afterEach(async t => {
        await t.fixture.close()
        await t.server.close()
      })

      await t.test('updates bindable state', t => {
        t.assert.partialDeepStrictEqual(state(t.element), {
          connected: false
        })
      })

      await t.test('notifies connected=false', t => {
        t.assert.strictEqual(t.event.detail.value, false)
      })
    })
  })

  await t.test('socket property', async t => {
    await t.test('with a consumer event listener', { timeout: 30000 }, async t => {
      t.beforeEach(async t => {
        t.server = await server()
        Object.assign(t, await mount({ url: t.server.url }))

        const [[socket]] = await Promise.all([
          once(t.server.io, 'connection'),
          t.element.connect()
        ])

        t.received = new Promise(resolve => {
          t.element.socket.on('server:event', payload => resolve(payload))
        })
        socket.emit('server:event', { text: 'hello' })
        t.payload = plain(await t.received)
      })

      t.afterEach(async t => {
        await t.fixture.close()
        await t.server.close()
      })

      await t.test('receives server events through the socket proxy', t => {
        t.assert.partialDeepStrictEqual(t.payload, { text: 'hello' })
      })
    })
  })

  await t.test('detached()', async t => {
    await t.test('when connected', { timeout: 30000 }, async t => {
      t.beforeEach(async t => {
        t.server = await server()
        Object.assign(t, await mount({ url: t.server.url }))

        const [[socket]] = await Promise.all([
          once(t.server.io, 'connection'),
          t.element.connect()
        ])

        t.disconnected = once(socket, 'disconnect')
        await t.fixture.close()
        t.reason = (await t.disconnected)[0]
      })

      t.afterEach(async t => {
        await t.server.close()
      })

      await t.test('clears the socket property', t => {
        t.assert.strictEqual(t.element.socket, null)
      })

      await t.test('disconnects the server socket', t => {
        t.assert.strictEqual(t.reason, 'client namespace disconnect')
      })
    })
  })
})

test('<socketio-worker> collaboration', { timeout: 45000 }, async t => {
  await t.test('socket property', { timeout: 45000 }, async t => {
    await t.test('with two elements in one room', { timeout: 45000 }, async t => {
      t.beforeEach(async t => {
        t.server = await server()
        t.alice = await fixture(html)
        t.bob = await fixture(html)

        t.server.io.on('connection', socket => {
          socket.join(socket.handshake.query.room)
          socket.on('client:event', payload => {
            socket.to(socket.handshake.query.room).emit('server:event', {
              from: socket.handshake.auth.name,
              payload
            })
          })
        })

        t.aliceElement = t.alice.mount('socketio-worker', attrs({
          url: t.server.url,
          auth: json({ name: 'alice' }),
          query: json({ room: 'shared' })
        }))
        t.bobElement = t.bob.mount('socketio-worker', attrs({
          url: t.server.url,
          auth: json({ name: 'bob' }),
          query: json({ room: 'shared' })
        }))

        await Promise.all([
          t.aliceElement.connect(),
          t.bobElement.connect()
        ])

        t.received = new Promise(resolve => {
          t.bobElement.socket.on('server:event', payload => resolve(payload))
        })

        await t.aliceElement.socket.emit('client:event', {
          text: 'hello bob'
        })
        t.entry = plain(await t.received)
      })

      t.afterEach(async t => {
        await t.alice.close()
        await t.bob.close()
        await t.server.close()
      })

      await t.test('delivers the relayed event', t => {
        t.assert.partialDeepStrictEqual(t.entry, {
          from: 'alice',
          payload: {
            text: 'hello bob'
          }
        })
      })

      await t.test('keeps the sender connected', t => {
        t.assert.partialDeepStrictEqual(state(t.aliceElement), {
          connected: true,
          loading: false
        })
      })

      await t.test('keeps the recipient connected', t => {
        t.assert.partialDeepStrictEqual(state(t.bobElement), {
          connected: true,
          loading: false
        })
      })
    })
  })
})

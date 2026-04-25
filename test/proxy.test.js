import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'
import { Fixture, once, plain, server } from '#test/utils'

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

  await t.test('ready', async t => {
    t.beforeEach(t => {
      t.proxy = new t.Proxy({
        src: t.fixture.script,
        lib: t.fixture.library
      })
    })

    await t.test('resolves disconnected snapshot', async t => {
      t.assert.partialDeepStrictEqual(plain(await t.proxy.ready), {
        id: null,
        connected: false,
        disconnected: true,
        active: false,
        reconnecting: false,
        readyState: null
      })
    })
  })

  await t.test('constructor', async t => {
    await t.test('with bad worker URL', async t => {
      t.beforeEach(t => {
        t.proxy = new t.Proxy({
          src: '/missing-worker.js',
          lib: t.fixture.library
        })
      })

      await t.test('rejects ready', async t => {
        await t.assert.rejects(
          () => t.proxy.ready,
          { message: /ENOENT|no such file/ }
        )
      })
    })

    await t.test('with bad library URL', async t => {
      t.beforeEach(t => {
        t.proxy = new t.Proxy({
          src: t.fixture.script,
          lib: 'lib/missing.js'
        })
      })

      await t.test('rejects ready', async t => {
        await t.assert.rejects(
          () => t.proxy.ready,
          { message: /ENOENT|no such file/ }
        )
      })
    })

    await t.test('with only a page socket.io script', async t => {
      t.beforeEach(t => {
        const clientScript = { src: t.fixture.library }
        const workerScript = { src: t.fixture.script }

        t.fixture.context.document = {
          currentScript: workerScript,
          scripts: [clientScript, workerScript]
        }

        t.proxy = new t.Proxy({ src: t.fixture.script })
      })

      await t.test('rejects ready', async t => {
        await t.assert.rejects(
          () => t.proxy.ready,
          { message: /lib is required/ }
        )
      })
    })
  })

  await t.test('worker lifecycle', async t => {
    await t.test('worker error', async t => {
      t.beforeEach(t => {
        const worker = {
          postMessage() {},
          terminateCalls: 0,
          terminate() {
            this.terminated = true
            this.terminateCalls++
          }
        }

        t.worker = worker
        t.proxy = new t.Proxy({ worker })
        t.proxy.ready.catch(() => null)
        worker.onerror(new Error('worker crashed'))
      })

      await t.test('rejects ready and future calls', async t => {
        await t.assert.rejects(
          () => t.proxy.ready,
          { message: /worker crashed/ }
        )
        await t.assert.rejects(
          () => t.proxy.emit('client:event'),
          { message: /worker crashed/ }
        )
      })

      await t.test('terminates worker', t => {
        t.assert.strictEqual(t.worker.terminated, true)
      })

      await t.test('terminate after error is a no-op', t => {
        t.assert.strictEqual(t.worker.terminateCalls, 1)
        t.proxy.terminate()
        t.assert.strictEqual(t.worker.terminateCalls, 1)
      })
    })

    await t.test('messageerror', async t => {
      t.beforeEach(t => {
        const worker = {
          postMessage() {},
          terminateCalls: 0,
          terminate() {
            this.terminated = true
            this.terminateCalls++
          }
        }

        t.worker = worker
        t.proxy = new t.Proxy({ worker })
        t.proxy.ready.catch(() => null)
        worker.onmessageerror(new Error('worker message failed'))
      })

      await t.test('rejects ready and future calls', async t => {
        await t.assert.rejects(
          () => t.proxy.ready,
          { message: /worker message failed/ }
        )
        await t.assert.rejects(
          () => t.proxy.emit('client:event'),
          { message: /worker message failed/ }
        )
      })

      await t.test('terminates worker', t => {
        t.assert.strictEqual(t.worker.terminated, true)
      })
    })

    await t.test('terminate()', async t => {
      t.beforeEach(t => {
        const worker = {
          postMessage() {},
          terminate() {
            this.terminated = true
          }
        }

        t.worker = worker
        t.proxy = new t.Proxy({ worker })
        t.ready = t.proxy.ready
        t.ready.catch(() => null)
        t.proxy.terminate()
      })

      await t.test('rejects pending and future calls', async t => {
        await t.assert.rejects(
          () => t.ready,
          { message: /terminated/ }
        )
        await t.assert.rejects(
          () => t.proxy.emit('client:event'),
          { message: /terminated/ }
        )
      })

      await t.test('terminates worker', t => {
        t.assert.strictEqual(t.worker.terminated, true)
      })
    })

    await t.test('postMessage failure', async t => {
      t.beforeEach(t => {
        t.proxy = new t.Proxy({
          worker: {
            postMessage() {
              throw new Error('post failed')
            },
            terminate() {}
          }
        })
      })

      await t.test('rejects calls', async t => {
        await t.assert.rejects(
          () => t.proxy.ready,
          { message: /post failed/ }
        )
        await t.assert.rejects(
          () => t.proxy.emit('client:event'),
          { message: /post failed/ }
        )
      })
    })

    await t.test('postMessage failure on later call', async t => {
      t.beforeEach(async t => {
        let calls = 0
        const worker = {
          onmessage: null,
          postMessage(message) {
            calls++

            if (calls > 1)
              throw new Error('post failed later')

            queueMicrotask(() => worker.onmessage?.({
              data: {
                channel: 'call',
                id: message.id,
                ok: true,
                result: { connected: false, disconnected: true }
              }
            }))
          },
          terminate() { this.terminated = true }
        }

        t.proxy = new t.Proxy({ worker })
        await t.proxy.ready
      })

      await t.test('rejects subsequent calls', async t => {
        await t.assert.rejects(
          () => t.proxy.emit('client:event'),
          { message: /post failed later/ }
        )
      })
    })

    await t.test('error response', async t => {
      t.beforeEach(async t => {
        const worker = {
          onmessage: null,
          postMessage(message) {
            queueMicrotask(() => worker.onmessage?.({
              data: {
                channel: 'call',
                id: message.id,
                ok: false,
                error: {
                  name: 'Error',
                  message: 'worker error',
                  stack: 'Error: worker error\n    at workerCallSite'
                }
              }
            }))
          },
          terminate() {}
        }

        t.proxy = new t.Proxy({ worker })
        t.failure = await t.proxy.ready.catch(error => error)
      })

      await t.test('preserves worker stack', t => {
        t.assert.match(t.failure.stack, /workerCallSite/)
      })
    })
  })

  await t.test('#connect', async t => {
    t.beforeEach(async t => {
      t.server = await server()
      t.proxy = new t.Proxy({
        src: t.fixture.script,
        lib: t.fixture.library,
        options: {
          autoConnect: false,
          transports: ['websocket']
        }
      })
    })

    await t.test('successful connection', async t => {
      t.beforeEach(async t => {
        t.connects = []
        t.created = []
        t.proxy.on('connect', patch => t.connects.push(plain(patch)))
        t.proxy.on('proxy:created', patch => t.created.push(plain(patch)))
        t.snapshot = plain(await t.proxy.connect(t.server.url))
      })

      await t.test('emits proxy:created once on socket creation', t => {
        t.assert.strictEqual(t.created.length, 1)
      })

      await t.test('returns connected snapshot', t => {
        t.assert.partialDeepStrictEqual(t.snapshot, {
          connected: true,
          disconnected: false,
          active: true,
          transport: 'websocket',
          reconnecting: false,
          readyState: 'open'
        })
      })

      await t.test('updates proxy properties', t => {
        t.assert.partialDeepStrictEqual(t.proxy, {
          connected: true,
          disconnected: false,
          active: true,
          transport: 'websocket',
          reconnecting: false,
          readyState: 'open'
        })
      })

      await t.test('emits connected event', t => {
        t.assert.partialDeepStrictEqual(t.connects[0], {
          connected: true,
          transport: 'websocket'
        })
      })

      await t.test('emits one connect event', t => {
        t.assert.strictEqual(t.connects.length, 1)
      })
    })

    await t.test('while connecting', async t => {
      t.beforeEach(t => {
        t.server.io.use((socket, next) => setTimeout(next, 50))
      })

      await t.test('rejects second call without replacing first', async t => {
        const connecting = t.proxy.connect(t.server.url)

        await t.assert.rejects(
          () => t.proxy.connect(t.server.url),
          { message: /already in progress/ }
        )
        t.assert.partialDeepStrictEqual(plain(await connecting), {
          connected: true
        })
      })
    })

    await t.test('with configured timeout', async t => {
      t.beforeEach(async t => {
        t.messages = []

        const context = vm.createContext({
          console,
          setTimeout,
          clearTimeout,
          queueMicrotask,
          Error,
          TypeError,
          RangeError,
          SyntaxError,
          Promise
        })

        const manager = {
          opts: {},
          _readyState: 'opening',
          _reconnecting: false,
          on() { return this },
          off() { return this },
          disconnect() {}
        }

        const fakeSocket = () => ({
          id: null,
          connected: false,
          disconnected: true,
          active: false,
          recovered: false,
          io: manager,
          on() { return this },
          once() { return this },
          off() { return this },
          onAny() { return this },
          offAny() { return this },
          connect() { return this },
          disconnect() { return this }
        })

        context.self = context
        context.importScripts = () => { context.io = fakeSocket }
        context.postMessage = message => t.messages.push(message)

        vm.runInContext(
          readFileSync(t.fixture.script, 'utf8'),
          context,
          { filename: t.fixture.script }
        )

        context.onmessage({
          data: {
            channel: 'call',
            id: 1,
            method: '__configure',
            args: [{ lib: 'fake.js', timeout: 30 }]
          }
        })
        await new Promise(resolve => setTimeout(resolve, 0))

        const response = new Promise(resolve => {
          context.postMessage = message => {
            t.messages.push(message)

            if (message.id === 2)
              resolve(message)
          }
        })

        context.onmessage({
          data: {
            channel: 'call',
            id: 2,
            method: 'connect',
            args: ['http://socket.test']
          }
        })

        t.response = await Promise.race([
          response,
          new Promise((resolve, reject) =>
            setTimeout(() =>
              reject(new Error('expected worker connect timeout')), 200)
          )
        ])
      })

      await t.test('rejects from the worker timer', t => {
        t.assert.partialDeepStrictEqual(t.response, {
          channel: 'call',
          id: 2,
          ok: false,
          error: {
            name: 'Error',
            message: 'Socket.IO connect: timed out'
          }
        })
      })
    })

    await t.test('when the call times out', async t => {
      t.beforeEach(async t => {
        let attempts = 0

        t.proxy = new t.Proxy({
          src: t.fixture.script,
          lib: t.fixture.library,
          timeout: 500,
          options: {
            autoConnect: false,
            transports: ['websocket']
          }
        })

        t.server.io.use((socket, next) => {
          attempts++

          if (attempts === 1) {
            t.releaseFirst = next
            return
          }

          next()
        })
      })

      await t.test(
        'does not keep a late worker connection',
        { timeout: 3000 },
        async t => {
          const secondConnection = new Promise(resolve => {
            t.server.io.on('connection', socket => {
              if (socket.handshake.auth.token === 'second')
                resolve(socket)
            })
          })

          await t.assert.rejects(
            () => t.proxy.connect(t.server.url, {
              auth: { token: 'first' }
            }),
            { message: /timed out/ }
          )

          t.releaseFirst()

          const [socket, snapshot] = await Promise.all([
            secondConnection,
            t.proxy.connect(t.server.url, {
              auth: { token: 'second' }
            })
          ])

          t.assert.partialDeepStrictEqual(plain(snapshot), {
            connected: true
          })
          t.assert.partialDeepStrictEqual(
            plain(socket.handshake.auth),
            { token: 'second' }
          )
        }
      )
    })

    await t.test('middleware connect_error', async t => {
      t.beforeEach(async t => {
        t.updates = []
        t.server.io.use((socket, next) => {
          const error = new Error('not authorized')

          error.data = { code: 'AUTH', retry: false }
          next(error)
        })
        t.proxy.on('connect_error', (patch, message) => {
          t.updates.push(plain(message.value))
        })
        t.failure = await t.proxy.connect(t.server.url).catch(error => error)
      })

      await t.test('rejects with details', t => {
        t.assert.partialDeepStrictEqual({
          name: t.failure.name,
          message: t.failure.message,
          data: t.failure.data
        }, {
          name: 'Error',
          message: 'not authorized',
          data: { code: 'AUTH', retry: false }
        })
      })

      await t.test('emits connect_error details', t => {
        t.assert.partialDeepStrictEqual(t.updates.at(-1), {
          name: 'Error',
          message: 'not authorized',
          data: { code: 'AUTH', retry: false }
        })
      })

      await t.test('leaves proxy disconnected', t => {
        t.assert.partialDeepStrictEqual(t.proxy, {
          connected: false,
          active: false
        })
      })
    })
  })

  await t.test('#disconnect', async t => {
    t.beforeEach(async t => {
      t.server = await server()
      t.proxy = new t.Proxy({
        src: t.fixture.script,
        lib: t.fixture.library,
        options: {
          autoConnect: false,
          transports: ['websocket']
        }
      })

      const [[socket]] = await Promise.all([
        once(t.server.io, 'connection'),
        t.proxy.connect(t.server.url)
      ])

      t.socket = socket
      t.disconnected = once(t.socket, 'disconnect')
      t.snapshot = plain(await t.proxy.disconnect())
    })

    await t.test('returns disconnected snapshot', t => {
      t.assert.partialDeepStrictEqual(t.snapshot, {
        connected: false,
        disconnected: true,
        active: false
      })
    })

    await t.test('disconnects server socket', async t => {
      t.assert.strictEqual(
        (await t.disconnected)[0],
        'client namespace disconnect'
      )
    })
  })

  await t.test('disconnect during connect', async t => {
    t.beforeEach(async t => {
      t.server = await server()
      t.proxy = new t.Proxy({
        src: t.fixture.script,
        lib: t.fixture.library,
        options: {
          autoConnect: false,
          transports: ['websocket']
        }
      })
      t.server.io.use((socket, next) => setTimeout(next, 50))
    })

    await t.test('rejects in-flight connect promise', async t => {
      const connecting = t.proxy.connect(t.server.url)

      await t.proxy.disconnect()
      await t.assert.rejects(
        () => connecting,
        { message: /aborted by disconnect/ }
      )
    })
  })

  await t.test('#close', async t => {
    t.beforeEach(async t => {
      t.server = await server()
      t.proxy = new t.Proxy({
        src: t.fixture.script,
        lib: t.fixture.library,
        options: {
          autoConnect: false,
          transports: ['websocket']
        }
      })

      const [[socket]] = await Promise.all([
        once(t.server.io, 'connection'),
        t.proxy.connect(t.server.url)
      ])

      t.socket = socket
      t.disconnected = once(t.socket, 'disconnect')
      t.closed = await t.proxy.close()
    })

    await t.test('returns proxy', t => {
      t.assert.strictEqual(t.closed, t.proxy)
    })

    await t.test('disconnects server socket', async t => {
      t.assert.strictEqual(
        (await t.disconnected)[0],
        'client namespace disconnect'
      )
    })

    await t.test('rejects future calls', async t => {
      await t.assert.rejects(
        () => t.proxy.emit('client:event'),
        { message: /terminated/ }
      )
    })
  })

  await t.test('#emit', async t => {
    await t.test('before socket creation', async t => {
      t.beforeEach(async t => {
        t.proxy = new t.Proxy({
          src: t.fixture.script,
          lib: t.fixture.library
        })
        await t.proxy.ready
      })

      await t.test('rejects', async t => {
        await t.assert.rejects(
          () => t.proxy.emit('client:event'),
          { message: /not been created/ }
        )
      })
    })

    await t.test('with non-JSON arguments', async t => {
      t.beforeEach(async t => {
        t.proxy = new t.Proxy({
          src: t.fixture.script,
          lib: t.fixture.library
        })
        await t.proxy.ready
      })

      await t.test('rejects before posting', async t => {
        await t.assert.rejects(
          () => t.proxy.emit('client:event', { callback() {} }),
          { name: 'TypeError', message: /JSON-safe/ }
        )
      })
    })

    await t.test('with undefined fields', async t => {
      t.beforeEach(async t => {
        const worker = {
          messages: [],
          postMessage(message) {
            this.messages.push(structuredClone(message))
            queueMicrotask(() => this.onmessage?.({
              data: {
                channel: 'call',
                id: message.id,
                ok: true,
                result: { connected: false, disconnected: true }
              }
            }))
          },
          terminate() {}
        }

        t.worker = worker
        t.proxy = new t.Proxy({ worker })
        await t.proxy.ready
        await t.proxy.emit('client:event', undefined, { value: undefined })
        t.message = t.worker.messages
          .find(message => message.method === 'emit')
      })

      await t.test('posts JSON-normalized call args', t => {
        t.assert.deepStrictEqual(t.message.args, [
          'client:event',
          null,
          {}
        ])
      })
    })

    await t.test('connected socket', async t => {
      t.beforeEach(async t => {
        t.server = await server()
        t.proxy = new t.Proxy({
          src: t.fixture.script,
          lib: t.fixture.library,
          options: {
            autoConnect: false,
            transports: ['websocket']
          }
        })

        const [[socket]] = await Promise.all([
          once(t.server.io, 'connection'),
          t.proxy.connect(t.server.url)
        ])

        t.socket = socket
      })

      await t.test('sends client events', async t => {
        const received = once(t.socket, 'client:event')

        await t.proxy.emit('client:event', { ok: true })

        t.assert.partialDeepStrictEqual(
          plain((await received)[0]),
          { ok: true }
        )
      })

      await t.test('serializes undefined like Socket.IO', async t => {
        const received = once(t.socket, 'client:event')

        await t.proxy.emit('client:event', undefined, { value: undefined })

        t.assert.partialDeepStrictEqual(
          plain(await received),
          [null, {}]
        )
      })

      await t.test('rejects reserved event names', async t => {
        await t.assert.rejects(
          () => t.proxy.emit('disconnect'),
          { message: /reserved event name/ }
        )
      })

      await t.test('leaves worker usable after rejection', async t => {
        await t.proxy.emit('disconnect').catch(() => null)

        const received = once(t.socket, 'client:event')

        await t.proxy.emit('client:event', { still: 'running' })

        t.assert.partialDeepStrictEqual(
          plain((await received)[0]),
          { still: 'running' }
        )
      })
    })
  })

  await t.test('#send', async t => {
    t.beforeEach(async t => {
      t.server = await server()
      t.proxy = new t.Proxy({
        src: t.fixture.script,
        lib: t.fixture.library,
        options: {
          autoConnect: false,
          transports: ['websocket']
        }
      })

      const [[socket]] = await Promise.all([
        once(t.server.io, 'connection'),
        t.proxy.connect(t.server.url)
      ])

      t.socket = socket
    })

    await t.test('sends message events', async t => {
      const received = once(t.socket, 'message')

      await t.proxy.send({ ok: true })

      t.assert.partialDeepStrictEqual(
        plain((await received)[0]),
        { ok: true }
      )
    })
  })

  await t.test('socket events', async t => {
    t.beforeEach(async t => {
      t.server = await server()
      t.proxy = new t.Proxy({
        src: t.fixture.script,
        lib: t.fixture.library,
        options: {
          autoConnect: false,
          transports: ['websocket']
        }
      })

      const [[socket]] = await Promise.all([
        once(t.server.io, 'connection'),
        t.proxy.connect(t.server.url)
      ])

      t.socket = socket
    })

    await t.test('forwards server events', async t => {
      const forwarded = new Promise(resolve => {
        t.proxy.on('server:event', payload => resolve(payload))
      })

      t.socket.emit('server:event', { id: 1 })

      t.assert.partialDeepStrictEqual(plain(await forwarded), { id: 1 })
    })

    await t.test('surfaces callback ack errors', async t => {
      const failed = new Promise(resolve => {
        t.proxy.on('proxy:socket_event_error', (patch, message) => {
          resolve(message.value)
        })
      })
      const forwarded = []

      t.proxy.on('server:needsAck', payload => forwarded.push(payload))
      t.socket.emit('server:needsAck', { id: 1 }, () => null)

      t.assert.partialDeepStrictEqual(plain(await failed), {
        name: 'TypeError',
        context: { event: 'server:needsAck' }
      })
      t.assert.deepStrictEqual(forwarded, [])
    })
  })

  await t.test('local listeners', async t => {
    t.beforeEach(async t => {
      t.server = await server()
      t.proxy = new t.Proxy({
        src: t.fixture.script,
        lib: t.fixture.library,
        options: {
          autoConnect: false,
          transports: ['websocket']
        }
      })

      const [[socket]] = await Promise.all([
        once(t.server.io, 'connection'),
        t.proxy.connect(t.server.url)
      ])

      t.socket = socket
    })

    await t.test('removes one handler', async t => {
      const calls = []
      const removed = payload => calls.push(['removed', payload])
      const kept = payload => calls.push(['kept', payload])
      const forwarded = new Promise(resolve => {
        t.proxy.on('server:event', payload => {
          kept(payload)
          resolve(payload)
        })
      })

      t.proxy.on('server:event', removed)
      t.proxy.off('server:event', removed)
      t.socket.emit('server:event', { id: 1 })

      t.assert.partialDeepStrictEqual(plain(await forwarded), { id: 1 })
      t.assert.partialDeepStrictEqual(calls, [
        ['kept', { id: 1 }]
      ])
    })

    await t.test('removes all handlers for event', async t => {
      const calls = []
      const witness = new Promise(resolve => {
        t.proxy.on('server:other', payload => resolve(payload))
      })

      t.proxy.on('server:event', payload => calls.push(['a', payload]))
      t.proxy.on('server:event', payload => calls.push(['b', payload]))
      t.proxy.off('server:event')

      t.socket.emit('server:event', { id: 1 })
      t.socket.emit('server:other', { id: 2 })

      t.assert.partialDeepStrictEqual(plain(await witness), { id: 2 })
      t.assert.deepStrictEqual(calls, [])
    })
  })

  await t.test('#call', async t => {
    t.beforeEach(async t => {
      t.server = await server()
      t.proxy = new t.Proxy({
        src: t.fixture.script,
        lib: t.fixture.library,
        options: {
          autoConnect: false,
          transports: ['websocket']
        }
      })

      const [[socket]] = await Promise.all([
        once(t.server.io, 'connection'),
        t.proxy.connect(t.server.url)
      ])

      t.socket = socket
    })

    await t.test('returns emitWithAck responses', async t => {
      t.socket.on('ack:event', (payload, reply) => {
        reply({ received: payload.count })
      })

      t.assert.partialDeepStrictEqual(
        plain(await t.proxy.call('emitWithAck', [
          'ack:event',
          { count: 2 }
        ])),
        { received: 2 }
      )
    })

    await t.test('rejects non-JSON method results', async t => {
      await t.assert.rejects(
        () => t.proxy.call('listeners', ['connect']),
        { name: 'TypeError', message: /JSON-safe/ }
      )
    })

    await t.test('rejects non-array args', async t => {
      await t.assert.rejects(
        async () => t.proxy.call('emitWithAck', 'not-an-array'),
        { name: 'TypeError', message: /expected array/ }
      )
    })

    await t.test('resolves concurrent calls independently', async t => {
      t.socket.on('echo:1', (data, reply) => reply({ source: 1, ...data }))
      t.socket.on('echo:2', (data, reply) => reply({ source: 2, ...data }))

      const [r1, r2] = await Promise.all([
        t.proxy.call('emitWithAck', ['echo:1', { v: 'a' }]),
        t.proxy.call('emitWithAck', ['echo:2', { v: 'b' }])
      ])

      t.assert.partialDeepStrictEqual(plain(r1), { source: 1, v: 'a' })
      t.assert.partialDeepStrictEqual(plain(r2), { source: 2, v: 'b' })
    })
  })

  await t.test('proxied socket methods', async t => {
    t.beforeEach(async t => {
      t.server = await server()
      t.proxy = new t.Proxy({
        src: t.fixture.script,
        lib: t.fixture.library,
        options: {
          autoConnect: false,
          transports: ['websocket']
        }
      })

      const [[socket]] = await Promise.all([
        once(t.server.io, 'connection'),
        t.proxy.connect(t.server.url)
      ])

      t.socket = socket
    })

    await t.test('applies timeout to emitWithAck', async t => {
      await t.proxy.timeout(20)

      await t.assert.rejects(
        () => t.proxy.emitWithAck('ack:missing', { count: 1 }),
        { message: /timed out/ }
      )
    })

    await t.test('chains timeout before emitWithAck', async t => {
      await t.assert.rejects(
        () => t.proxy
          .timeout(20)
          .emitWithAck('ack:missing', { count: 1 }),
        { message: /timed out/ }
      )
    })

    await t.test('preserves server event forwarding after offAny()', async t => {
      await t.proxy.offAny()

      const forwarded = new Promise(resolve => {
        t.proxy.on('server:event', payload => resolve(payload))
      })

      t.socket.emit('server:event', { ok: true })

      t.assert.partialDeepStrictEqual(plain(await forwarded), { ok: true })
    })

    await t.test('preserves lifecycle updates after removeAllListeners()', async t => {
      const disconnected = new Promise(resolve => {
        t.proxy.on('disconnect', patch => resolve(patch))
      })

      await t.proxy.removeAllListeners()
      t.socket.disconnect()

      t.assert.partialDeepStrictEqual(plain(await disconnected), {
        connected: false,
        disconnected: true
      })
      t.assert.partialDeepStrictEqual(t.proxy, {
        connected: false,
        disconnected: true
      })
    })
  })

  await t.test('#managerCall', async t => {
    t.beforeEach(async t => {
      t.server = await server()
      t.proxy = new t.Proxy({
        src: t.fixture.script,
        lib: t.fixture.library,
        options: {
          autoConnect: false,
          transports: ['websocket']
        }
      })
      await t.proxy.connect(t.server.url)
    })

    await t.test('calls manager methods', async t => {
      await t.proxy.managerCall('reconnectionAttempts', [3])

      t.assert.strictEqual(
        await t.proxy.managerCall('reconnectionAttempts'),
        3
      )
    })
  })

  await t.test('#set', async t => {
    t.beforeEach(async t => {
      t.server = await server()
      t.proxy = new t.Proxy({
        src: t.fixture.script,
        lib: t.fixture.library,
        options: {
          autoConnect: false,
          transports: ['websocket']
        }
      })
    })

    await t.test('before connect', async t => {
      await t.test('sets auth', async t => {
        await t.proxy.ready
        await t.proxy.set('auth.token', 'abc')

        const [[socket]] = await Promise.all([
          once(t.server.io, 'connection'),
          t.proxy.connect(t.server.url)
        ])

        t.assert.partialDeepStrictEqual(
          plain(socket.handshake.auth),
          { token: 'abc' }
        )
      })

      await t.test('sets query alias', async t => {
        await t.proxy.ready
        await t.proxy.set('query.room', 'blue')

        const [[socket]] = await Promise.all([
          once(t.server.io, 'connection'),
          t.proxy.connect(t.server.url)
        ])

        t.assert.strictEqual(socket.handshake.query.room, 'blue')
      })

      await t.test('sets original query path', async t => {
        await t.proxy.ready
        await t.proxy.set('io.opts.query.room', 'gold')

        const [[socket]] = await Promise.all([
          once(t.server.io, 'connection'),
          t.proxy.connect(t.server.url)
        ])

        t.assert.strictEqual(socket.handshake.query.room, 'gold')
      })

      await t.test('merges object', async t => {
        await t.proxy.ready
        await t.proxy.set({
          auth: { token: 'abc' },
          query: { room: 'green' }
        })

        const [[socket]] = await Promise.all([
          once(t.server.io, 'connection'),
          t.proxy.connect(t.server.url)
        ])

        t.assert.partialDeepStrictEqual(
          plain(socket.handshake.auth),
          { token: 'abc' }
        )
        t.assert.strictEqual(socket.handshake.query.room, 'green')
      })

      await t.test('serializes undefined like Socket.IO', async t => {
        await t.proxy.ready
        await t.proxy.set({ auth: { token: undefined } })

        const [[socket]] = await Promise.all([
          once(t.server.io, 'connection'),
          t.proxy.connect(t.server.url)
        ])

        t.assert.partialDeepStrictEqual(plain(socket.handshake.auth), {})
      })

      await t.test('chains calls', async t => {
        await t.proxy.ready

        const [[socket], snapshot] = await Promise.all([
          once(t.server.io, 'connection'),
          t.proxy
            .set('auth', { token: 'abc' })
            .set('query', { room: 'green' })
            .connect(t.server.url)
        ])

        t.assert.partialDeepStrictEqual(
          plain(snapshot),
          { connected: true }
        )
        t.assert.partialDeepStrictEqual(
          plain(socket.handshake.auth),
          { token: 'abc' }
        )
        t.assert.strictEqual(socket.handshake.query.room, 'green')
      })

      await t.test('sets nested array paths', async t => {
        await t.proxy.ready
        await t.proxy.set('auth.items', [
          { bar: 'baz' },
          { bar: 'baz' },
          { bar: 'baz' }
        ])
        await t.proxy.set('auth.items.1.bar', 'qux')

        const [[socket]] = await Promise.all([
          once(t.server.io, 'connection'),
          t.proxy.connect(t.server.url)
        ])

        t.assert.partialDeepStrictEqual(
          plain(socket.handshake.auth),
          {
            items: [
              { bar: 'baz' },
              { bar: 'qux' },
              { bar: 'baz' }
            ]
          }
        )
      })
    })

    await t.test('after connect', async t => {
      t.beforeEach(async t => {
        const [[socket]] = await Promise.all([
          once(t.server.io, 'connection'),
          t.proxy.connect(t.server.url)
        ])

        t.socket = socket
      })

      await t.test('updates reconnect options', async t => {
        await t.proxy.set({
          auth: { token: 'next' },
          query: { room: 'green' }
        })
        await Promise.all([
          once(t.socket, 'disconnect'),
          t.proxy.disconnect()
        ])

        const [[socket]] = await Promise.all([
          once(t.server.io, 'connection'),
          t.proxy.connect()
        ])

        t.assert.partialDeepStrictEqual(
          plain(socket.handshake.auth),
          { token: 'next' }
        )
        t.assert.strictEqual(socket.handshake.query.room, 'green')
      })

      await t.test('mutates arbitrary socket paths', async t => {
        await t.proxy.set('io.opts.query', {})
        await t.proxy.set('io.opts.query.room', 'purple')
        await t.proxy.disconnect()

        const [[socket]] = await Promise.all([
          once(t.server.io, 'connection'),
          t.proxy.connect()
        ])

        t.assert.strictEqual(socket.handshake.query.room, 'purple')
      })

      await t.test('rejects missing parents', async t => {
        const error = await t.proxy
          .set('missing.branch.value', true)
          .catch(error => error)

        t.assert.strictEqual(error.name, 'TypeError')
        t.assert.match(error.message, /parent does not exist/)
      })
    })

    await t.test('invalid input', async t => {
      await t.test('rejects unsafe paths', async t => {
        await t.proxy.ready

        const error = await t.proxy
          .set('__proto__.polluted', true)
          .catch(error => error)

        t.assert.strictEqual(error.name, 'RangeError')
        t.assert.match(error.message, /invalid segment/)
      })

      await t.test('rejects non-JSON values', async t => {
        await t.proxy.ready

        await t.assert.rejects(
          () => t.proxy.set('auth.token', () => null),
          { name: 'TypeError', message: /JSON-safe/ }
        )
      })

      await t.test('rejects non-finite numbers', async t => {
        await t.proxy.ready

        await t.assert.rejects(
          () => t.proxy.set('auth.count', Infinity),
          { name: 'RangeError', message: /non-finite/ }
        )
      })

      await t.test('rejects sparse arrays', async t => {
        const value = []

        value[1] = 'gap'
        await t.proxy.ready

        await t.assert.rejects(
          () => t.proxy.set('auth.items', value),
          { name: 'TypeError', message: /sparse arrays/ }
        )
      })

      await t.test('rejects chained failures', async t => {
        await t.proxy.ready

        await t.assert.rejects(
          () => t.proxy
            .set('__proto__.polluted', true)
            .set('auth', { token: 'abc' }),
          { name: 'RangeError', message: /invalid segment/ }
        )
      })
    })
  })
})

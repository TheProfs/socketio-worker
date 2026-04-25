# Socket.IO Worker

socket.io off the main thread.  
The worker owns the real Socket.IO client,
while the page talks to `SocketIOWorker`.  

## Usage

Serve the Socket.IO browser client and pass that URL as `lib`.
The page only needs the worker proxy script:

```html
<script src="/socketio-worker.js"></script>
```

The worker does not inspect page script tags.

```js
const io = new SocketIOWorker({
  src: '/socketio-worker.js',
  lib: '/socket.io/socket.io.js',
  url: 'https://example.com',
  options: {
    autoConnect: false,
    transports: ['websocket']
  }
})

await io.set({ auth: { token: 'foo' }, query: { room: 'bar' } }).connect()

io.on('connect',       patch => console.log(patch.transport))
io.on('disconnect',    patch => console.log(patch.disconnected))
io.on('connect_error', (_, message) => console.log(message.value))

io.on('example:event', payload => console.log(payload))

await io.emit('example:event', { ok: true })
await io.close()
```

Lifecycle listeners receive `(patch, message)`:

- `patch` — connection snapshot (`connected`, `transport`, etc.)
- `message.value` — cause for `connect_error` / `disconnect`

> [!INFO]
> - Use `set(path, value)` or `set(object)` for Socket.IO mutations.  
>   Normal Socket.IO assignment is synchronous; worker-owned mutation must cross
>   the proxy boundary.  
> - Async calls are chainable; await the final call.  

Use `emitWithAck()` when the server must respond:

```js
const ack = await io.emitWithAck('update item', '1', {
  name: 'updated'
})
```

## Gotchas

- Payloads, call args, and method results use Socket.IO JSON serialization.  
- `undefined` follows Socket.IO behavior: array slots become `null`,
  object fields are omitted.  
- Callback acks, like `emit(..., callback)`, are not implemented.  
- Use `set(path, value)` or `set(object)` for Socket.IO mutations.  
  Direct proxy mutations like: `io.auth.token = 'abc'` are local only.  
- Use `close()` for graceful cleanup; `terminate()` is immediate.  

## Run tests

```bash
npm i
npm t
```

## Author

[@TheProfs](https://github.com/TheProfs)

## License

[MIT][mit]

[mit]: https://opensource.org/licenses/MIT

import { readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

const insideRoot = file => {
  const offset = relative(root, file)

  return offset === '' || (!offset.startsWith('..') && !isAbsolute(offset))
}

export const resolveAsset = value => {
  const path = String(value)
  const file = path.startsWith('file://')
    ? fileURLToPath(path)
    : isAbsolute(path) && insideRoot(resolve(path))
      ? resolve(path)
      : resolve(root, path.replace(/^\/+/, ''))

  if (!insideRoot(file))
    throw new RangeError('WorkerHost asset: path escapes project root')

  return file
}

export class WorkerHost {
  #workers = new Set()

  constructor() {
    this.script = `${root}/socketio-worker.js`
    this.library = `${root}/test/utils/socket.io.js`
  }

  mainContext() {
    const context = vm.createContext({
      console,
      setTimeout,
      clearTimeout,
      queueMicrotask,
      Error,
      TypeError,
      RangeError,
      SyntaxError,
      Promise,
      Proxy,
      structuredClone
    })

    context.self = context
    context.Worker = this.Worker()

    return context
  }

  Worker() {
    const host = this

    return class WorkerBridge {
      constructor(script) {
        this.script = resolveAsset(script)
        this.terminated = false
        this.context = host.workerContext(this)

        host.#workers.add(this)

        vm.runInContext(readFileSync(this.script, 'utf8'), this.context, {
          filename: this.script
        })
      }

      postMessage(data) {
        const message = structuredClone(data)

        queueMicrotask(() => {
          if (this.terminated)
            return

          try {
            this.context.onmessage?.({ data: message })
          } catch (error) {
            this.onerror?.(error)
          }
        })
      }

      terminate() {
        this.terminated = true
        host.#workers.delete(this)
      }
    }
  }

  workerContext(worker) {
    const context = vm.createContext({
      console,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      queueMicrotask,
      WebSocket,
      Blob,
      ArrayBuffer,
      DataView,
      Uint8Array,
      TextEncoder,
      TextDecoder,
      URL,
      Error,
      TypeError,
      RangeError,
      SyntaxError,
      Promise,
      structuredClone
    })

    context.self = context
    context.location = { protocol: 'http:', host: '127.0.0.1' }
    context.postMessage = data => {
      const message = structuredClone(data)

      queueMicrotask(() => {
        if (!worker.terminated)
          worker.onmessage?.({ data: message })
      })
    }
    context.importScripts = (...scripts) => {
      for (const script of scripts) {
        const file = resolveAsset(script)

        vm.runInContext(
          readFileSync(file, 'utf8'),
          context,
          { filename: file }
        )
      }
    }

    return context
  }

  close() {
    for (const worker of this.#workers)
      worker.terminate()

    this.#workers.clear()
  }
}

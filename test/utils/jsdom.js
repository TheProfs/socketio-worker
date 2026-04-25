import jsdom from 'jsdom'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { WorkerHost } from './worker.js'

const { JSDOM } = jsdom

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

let cached = null

const boot = async html => {
  if (typeof html !== 'string')
    throw new TypeError('fixture: html must be a string')

  if (cached && cached.html === html)
    return cached.dom

  const workerHost = new WorkerHost()
  const dom = new JSDOM(html, {
    url: pathToFileURL(root + '/').href,
    resources: 'usable',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse: window => {
      window.Worker = workerHost.Worker()
    }
  })

  dom.__workerHost = workerHost

  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('WebComponentsReady timeout after 9000ms')),
      9000
    )
    dom.window.addEventListener('WebComponentsReady', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })

  cached = { html, dom }
  return dom
}

export const fixture = async html => {
  const dom = await boot(html)
  let element = null

  const api = {
    mount(tag, attrs = {}) {
      element = dom.window.document.createElement(tag)

      for (const [name, value] of Object.entries(attrs)) {
        if (value === false || value == null)
          continue

        element.setAttribute(name, value === true ? '' : String(value))
      }

      dom.window.document.body.appendChild(element)
      dom.window.Polymer.dom.flush()
      return element
    },

    async waitFor(check, { timeout = 2000, interval = 10, message } = {}) {
      const start = Date.now()

      while (Date.now() - start < timeout) {
        const value = check(element)

        if (value)
          return value

        await new Promise(resolve => setTimeout(resolve, interval))
      }

      throw new Error(message || 'fixture waitFor() timed out')
    },

    remove() {
      if (!element)
        return api

      element.remove()
      dom.window.Polymer.dom.flush()
      element = null
      return api
    },

    async close() {
      const socket = element?.socket

      api.remove()
      await socket?.close?.().catch(() => null)

      return api
    }
  }

  return api
}

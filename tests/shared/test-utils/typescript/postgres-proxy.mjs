// Copyright (C) 2026 Garudex Labs. All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// TCP failure injection against a disposable PostgreSQL endpoint, without external dependencies.

import { createConnection, createServer } from 'node:net'

export async function postgresProxy(databaseUrl) {
  const target = new URL(databaseUrl)
  const host = target.hostname
  const port = Number(target.port || 5432)
  const sockets = new Set()
  let blockConnections = false
  let discardResponses = false
  const server = createServer((client) => {
    if (blockConnections) return client.destroy()
    const upstream = createConnection({ host, port })
    sockets.add(client)
    sockets.add(upstream)
    const close = () => {
      client.destroy()
      upstream.destroy()
      sockets.delete(client)
      sockets.delete(upstream)
    }
    client.on('error', close).on('close', close)
    upstream.on('error', close).on('close', close)
    client.pipe(upstream)
    upstream.on('data', (data) => {
      if (!discardResponses) client.write(data)
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  target.hostname = '127.0.0.1'
  target.port = String(address.port)
  return {
    url: target.href,
    blackholeResponses() {
      discardResponses = true
    },
    disconnect() {
      blockConnections = true
      for (const socket of sockets) socket.destroy()
    },
    restore() {
      discardResponses = false
      blockConnections = false
    },
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
    },
  }
}

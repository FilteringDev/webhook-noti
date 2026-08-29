import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { Socket } from 'node:net'
import { SocksClient, type SocksProxy } from 'socks'

const SchemeToSocksType: Record<string, 4 | 5> = {
  socks: 5,
  socks4: 4,
  socks4a: 4,
  socks5: 5,
  socks5h: 5
}

export interface SocksBridge {
  Url: string
  Close: () => Promise<void>
}

function ParseSocksProxyUrl(Value: string): SocksProxy {
  let Parsed: URL
  try {
    Parsed = new URL(Value)
  } catch {
    throw new Error('SOCKS_PROXY_URL must be a valid URL')
  }
  const Type = SchemeToSocksType[Parsed.protocol.replace(/:$/, '')]
  if (Type === undefined) throw new Error('SOCKS_PROXY_URL must use a socks4, socks4a, socks5, or socks5h scheme')
  if (Parsed.hostname.length === 0 || Parsed.port.length === 0) throw new Error('SOCKS_PROXY_URL must include a host and port')
  return {
    host: Parsed.hostname,
    port: Number(Parsed.port),
    type: Type,
    ...(Parsed.username.length > 0 ? { userId: decodeURIComponent(Parsed.username) } : {}),
    ...(Parsed.password.length > 0 ? { password: decodeURIComponent(Parsed.password) } : {})
  }
}

function DestroySocket(SocketValue: Socket): void {
  if (!SocketValue.destroyed) SocketValue.destroy()
}

// Bridges local HTTP CONNECT tunnels onto an upstream SOCKS proxy, so any client that only
// knows how to speak HTTP-proxy (undici ProxyAgent, https-proxy-agent, global-agent) can be
// routed through a SOCKS5 upstream.
export async function StartSocksBridge(ProxyUrl: string): Promise<SocksBridge> {
  const Proxy = ParseSocksProxyUrl(ProxyUrl)

  async function HandleConnect(Request: IncomingMessage, ClientSocket: Socket, Head: Buffer): Promise<void> {
    const Match = /^([^:]+):(\d+)$/.exec(Request.url ?? '')
    if (Match === null || Match[1] === undefined || Match[2] === undefined) {
      DestroySocket(ClientSocket)
      return
    }
    try {
      const { socket: RemoteSocket } = await SocksClient.createConnection({
        command: 'connect',
        destination: { host: Match[1], port: Number(Match[2]) },
        proxy: Proxy
      })
      ClientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (Head.length > 0) RemoteSocket.write(Head)
      ClientSocket.pipe(RemoteSocket)
      RemoteSocket.pipe(ClientSocket)
      ClientSocket.on('error', () => DestroySocket(RemoteSocket))
      ClientSocket.on('close', () => DestroySocket(RemoteSocket))
      RemoteSocket.on('error', () => DestroySocket(ClientSocket))
      RemoteSocket.on('close', () => DestroySocket(ClientSocket))
    } catch {
      if (!ClientSocket.destroyed) ClientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
    }
  }

  // Only CONNECT tunneling is supported; this is a private relay, not a general-purpose proxy.
  const BridgeServer: Server = createServer((IncomingRequest, Response) => {
    void IncomingRequest
    Response.writeHead(405).end()
  })
  BridgeServer.on('connect', (Request, ClientSocket, Head) => {
    void HandleConnect(Request, ClientSocket as Socket, Head)
  })

  await new Promise<void>((ResolveListen) => BridgeServer.listen(0, '127.0.0.1', ResolveListen))
  const Address = BridgeServer.address()
  if (Address === null || typeof Address === 'string') throw new Error('Failed to determine SOCKS bridge address')

  return {
    Url: `http://127.0.0.1:${Address.port}`,
    async Close(): Promise<void> {
      await new Promise<void>((ResolveClose, RejectClose) => {
        BridgeServer.close((CloseError) => CloseError === undefined ? ResolveClose() : RejectClose(CloseError))
      })
    }
  }
}

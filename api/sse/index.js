import { handleSseProxy } from '../../lib/proxy/streamProxy.js'

export default function handler(req, res) {
    return handleSseProxy(req, res)
}

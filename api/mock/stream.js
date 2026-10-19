import { handleMockStream } from '../../lib/mock/handlers.js'

export default function handler(req, res) {
    return handleMockStream(req, res)
}

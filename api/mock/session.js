import { handleMockSession } from '../../lib/mock/handlers.js'

export default function handler(req, res) {
    return handleMockSession(req, res)
}

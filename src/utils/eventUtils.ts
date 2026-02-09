import type { EventMessage } from '../types'

export const colorMap: Record<string, string> = {
    'AUTH_LOGIN': 'bg-blue-600 hover:bg-blue-700',
    'AUTH_LOGOUT': 'bg-red-600 hover:bg-red-700',
    'AUTH_TOKEN_REFRESH': 'bg-cyan-600 hover:bg-cyan-700',
    'USER_CREATE': 'bg-green-600 hover:bg-green-700',
    'USER_UPDATE': 'bg-amber-600 hover:bg-amber-700',
    'USER_DELETE': 'bg-red-700 hover:bg-red-800',
    'ROLE_ASSIGN': 'bg-purple-600 hover:bg-purple-700',
    'PERMISSION_GRANT': 'bg-indigo-600 hover:bg-indigo-700',
    'PERMISSION_REVOKE': 'bg-pink-600 hover:bg-pink-700',
}

export const getColorForType = (type: string): string => {
    return colorMap[type] || 'bg-slate-600 hover:bg-slate-700'
}

export const formatTime = (seconds: number): string => {
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    const secs = seconds % 60
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
}

export const getFieldValue = (event: EventMessage, fieldPath: string): string | null => {
    try {
        let obj: any = {}
        try {
            obj = JSON.parse(event.data)
        } catch {
            obj = { data: event.data, type: event.type, parsedType: event.parsedType }
        }

        const keys = fieldPath.split('.')
        let value = obj
        for (const key of keys) {
            if (value && typeof value === 'object' && key in value) {
                value = value[key]
            } else {
                return null
            }
        }
        return value != null ? String(value) : null
    } catch {
        return null
    }
}

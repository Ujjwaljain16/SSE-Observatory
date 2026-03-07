import crypto from 'crypto';

// Use a provided secret or fallback to VERCEL_GIT_COMMIT_SHA to ensure consistency across Lambdas.
// If both are missing, we use a fallback that is stable for the duration of the deployment.
const SECRET = process.env.PROXY_SECRET 
    || process.env.VERCEL_GIT_COMMIT_SHA 
    || 'sse-observatory-default-stable-secret-3g4h5j6k7l8m';

export function encryptTicket(url, token) {
    const payload = JSON.stringify({ url, token, exp: Date.now() + 30000 });
    const iv = crypto.randomBytes(16);
    const key = crypto.createHash('sha256').update(SECRET).digest();
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    
    let enc = cipher.update(payload, 'utf8', 'hex');
    enc += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    
    return `${iv.toString('hex')}:${enc}:${authTag}`;
}

export function decryptTicket(ticketId) {
    try {
        const parts = ticketId.split(':');
        if (parts.length !== 3) return null;
        
        const iv = Buffer.from(parts[0], 'hex');
        const authTag = Buffer.from(parts[2], 'hex');
        const key = crypto.createHash('sha256').update(SECRET).digest();
        
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(authTag);
        
        let dec = decipher.update(parts[1], 'hex', 'utf8');
        dec += decipher.final('utf8');
        
        const data = JSON.parse(dec);
        if (data.exp < Date.now()) return null;
        return data;
    } catch (e) {
        return null;
    }
}

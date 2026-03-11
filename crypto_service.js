import keytar from 'keytar';
import crypto from 'crypto';

const SERVICE_NAME = 'SecureClaw_Agent';
const ACCOUNT_NAME = 'engram_aes_key';
const ALGORITHM = 'aes-256-gcm';

export class CryptoService {
    static async getEncryptionKey() {
        try {
            let keyHex = await keytar.getPassword(SERVICE_NAME, ACCOUNT_NAME);
            if (!keyHex) {
                // Generar nueva clave criptográficamente segura de 256 bits (32 bytes)
                const key = crypto.randomBytes(32);
                keyHex = key.toString('hex');
                await keytar.setPassword(SERVICE_NAME, ACCOUNT_NAME, keyHex);
                console.log("🔑 [CryptoService]: Nueva clave AES-256 generada y guardada de forma segura en Windows Credential Manager.");
            }
            return Buffer.from(keyHex, 'hex');
        } catch (error) {
            console.error("❌ [CryptoService]: Error crítico accediendo al Keychain de Windows:", error);
            throw error;
        }
    }

    static async encryptData(text) {
        const key = await this.getEncryptionKey();
        const iv = crypto.randomBytes(12); // Vector de Inicialización de 12 bytes recomendado para GCM
        const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
        
        let encrypted = cipher.update(text, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        const authTag = cipher.getAuthTag().toString('hex');
        
        // El formato almacenado es 'iv:authTag:datosEncriptados'
        return `${iv.toString('hex')}:${authTag}:${encrypted}`;
    }

    static async decryptData(encryptedText) {
        if (!encryptedText || typeof encryptedText !== 'string' || !encryptedText.includes(':')) {
            throw new Error('Formato encriptado inválido o texto plano detectado (Faltan separadores).');
        }

        const key = await this.getEncryptionKey();
        const parts = encryptedText.split(':');
        
        if (parts.length !== 3) {
            throw new Error('Formato encriptado inválido (No corresponde a iv:authTag:data).');
        }
        
        const iv = Buffer.from(parts[0], 'hex');
        const authTag = Buffer.from(parts[1], 'hex');
        const encrypted = parts[2];
        
        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
        decipher.setAuthTag(authTag);
        
        let decrypted = decipher.update(encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    }
}

import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const prefix = 'v1.';
const algorithm = 'aes-256-gcm';

@Injectable()
export class StorageSecretBox {
  private key() {
    const encoded = process.env.STORAGE_ENCRYPTION_KEY?.trim();
    if (!encoded)
      throw new ServiceUnavailableException(
        '尚未配置 STORAGE_ENCRYPTION_KEY，无法保存存储访问密钥。',
      );
    const key = Buffer.from(encoded, 'base64');
    if (key.length !== 32)
      throw new ServiceUnavailableException(
        'STORAGE_ENCRYPTION_KEY 必须是 32 字节的 base64 密钥。',
      );
    return key;
  }

  isEncrypted(value: string) {
    return value.startsWith(prefix);
  }

  encryptIfNeeded(value: string) {
    return this.isEncrypted(value) ? value : this.encrypt(value);
  }

  encrypt(value: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv(algorithm, this.key(), iv);
    const ciphertext = Buffer.concat([
      cipher.update(value, 'utf8'),
      cipher.final(),
    ]);
    return `${prefix}${iv.toString('base64url')}.${cipher
      .getAuthTag()
      .toString('base64url')}.${ciphertext.toString('base64url')}`;
  }

  // Legacy plaintext stays readable until the next save re-encrypts it.
  decrypt(value: string) {
    if (!this.isEncrypted(value)) return value;
    const parts = value.slice(prefix.length).split('.');
    if (parts.length !== 3)
      throw new Error('Invalid encrypted storage secret.');
    const decipher = createDecipheriv(
      algorithm,
      this.key(),
      Buffer.from(parts[0]!, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(parts[1]!, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(parts[2]!, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }
}

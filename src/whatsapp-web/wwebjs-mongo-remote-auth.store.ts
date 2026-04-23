import * as fs from 'fs/promises';
import * as path from 'path';
import mongoose, { type Connection } from 'mongoose';
import { MongoStore } from 'wwebjs-mongo';

/** MongoStore reads `mongoose.connection.db`; Nest default connection lives on injected `Connection`. */
function mongooseForStore(connection: Connection): typeof mongoose {
  return new Proxy(mongoose, {
    get(target, prop, receiver) {
      if (prop === 'connection') {
        return connection;
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  }) as typeof mongoose;
}

/**
 * wwebjs-mongo {@link MongoStore} expects `${session}.zip` in `process.cwd()`,
 * while whatsapp-web.js {@link RemoteAuth} writes the archive under `dataPath`.
 * This wrapper bridges that path mismatch.
 */
export class WwebMongoRemoteAuthStore {
  private readonly inner: InstanceType<typeof MongoStore>;

  constructor(
    private readonly remoteAuthDataPath: string,
    nestConnection: Connection,
  ) {
    this.inner = new MongoStore({ mongoose: mongooseForStore(nestConnection) });
  }

  sessionExists(options: { session: string }): Promise<boolean> {
    return this.inner.sessionExists(options);
  }

  extract(options: { session: string; path: string }): Promise<void> {
    return this.inner.extract(options);
  }

  delete(options: { session: string }): Promise<void> {
    return this.inner.delete(options);
  }

  async save(options: { session: string }): Promise<void> {
    const src = path.join(this.remoteAuthDataPath, `${options.session}.zip`);
    const staging = path.join(process.cwd(), `${options.session}.zip`);
    try {
      await fs.copyFile(src, staging);
      await this.inner.save(options);
    } finally {
      await fs.unlink(staging).catch(() => undefined);
    }
  }
}

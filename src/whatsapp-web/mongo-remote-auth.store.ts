import * as fs from 'fs';
import * as path from 'path';
import type { Connection } from 'mongoose';
import mongoose from 'mongoose';
/**
 * GridFS store for whatsapp-web.js RemoteAuth, aligned with MongoDB session layout
 * described for {@link https://wwebjs.dev/guide/creating-your-bot/authentication.html#remoteauth-strategy RemoteAuth}.
 *
 * RemoteAuth passes a filesystem path to `save()` but a session folder name to
 * `sessionExists` / `extract` / `delete`. Bucket names must use the session key only
 * (e.g. `RemoteAuth-mySession`), not the full path.
 */
export class MongoRemoteAuthStore {
  constructor(private readonly connection: Connection) {}

  private get db() {
    const db = this.connection.db;
    if (!db) {
      throw new Error(
        'MongoRemoteAuthStore: MongoDB native db is not available; use the NestJS Mongoose connection.',
      );
    }
    return db;
  }

  private sessionKey(session: string): string {
    const normalized = session.replace(/\\/g, '/');
    return normalized.includes('/') ? path.basename(normalized) : session;
  }

  async sessionExists(options: { session: string }): Promise<boolean> {
    const key = this.sessionKey(options.session);
    const coll = this.db.collection(`whatsapp-${key}.files`);
    const count = await coll.countDocuments();
    return count > 0;
  }

  async save(options: { session: string }): Promise<void> {
    const fullPrefix = options.session;
    const key = this.sessionKey(fullPrefix);
    const zipPath = `${fullPrefix}.zip`;
    const bucket = new mongoose.mongo.GridFSBucket(this.db, {
      bucketName: `whatsapp-${key}`,
    });
    await new Promise<void>((resolve, reject) => {
      fs.createReadStream(zipPath)
        .pipe(bucket.openUploadStream(`${key}.zip`))
        .on('error', (err: Error) => reject(err))
        .on('close', () => resolve());
    });
    await this.deletePrevious(bucket, key);
  }

  private async deletePrevious(
    bucket: mongoose.mongo.GridFSBucket,
    key: string,
  ): Promise<void> {
    const documents = await bucket.find({ filename: `${key}.zip` }).toArray();
    if (documents.length > 1) {
      const oldSession = documents.reduce((a, b) =>
        a.uploadDate < b.uploadDate ? a : b,
      );
      await bucket.delete(oldSession._id);
    }
  }

  async extract(options: { session: string; path: string }): Promise<void> {
    const key = this.sessionKey(options.session);
    const bucket = new mongoose.mongo.GridFSBucket(this.db, {
      bucketName: `whatsapp-${key}`,
    });
    await new Promise<void>((resolve, reject) => {
      bucket
        .openDownloadStreamByName(`${key}.zip`)
        .pipe(fs.createWriteStream(options.path))
        .on('error', (err: Error) => reject(err))
        .on('close', () => resolve());
    });
  }

  async delete(options: { session: string }): Promise<void> {
    const key = this.sessionKey(options.session);
    const bucket = new mongoose.mongo.GridFSBucket(this.db, {
      bucketName: `whatsapp-${key}`,
    });
    const documents = await bucket.find({ filename: `${key}.zip` }).toArray();
    for (const doc of documents) {
      await bucket.delete(doc._id);
    }
  }
}

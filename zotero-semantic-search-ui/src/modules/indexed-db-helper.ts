import Dexie from 'dexie';
import { compressToUTF16, decompressFromUTF16 } from 'lz-string';

export class IndexedDbHelper extends Dexie {
  private texts: Dexie.Table<{ id: string; compressedText: string }, string>;

  constructor() {
    super('TextDatabase');
    this.version(1).stores({
      texts: 'id',
    });

    this.texts = this.table('texts');
  }

  async addText(id: string, texts: Array<string>): Promise<void> {
    const compressedText = compressToUTF16(JSON.stringify(texts));
    await this.texts.put({ id, compressedText });
  }

  async getText(id: string): Promise<Array<string> | null> {
    const result = await this.texts.get(id);
    if (result?.compressedText) {
      const decompressedText = decompressFromUTF16(result.compressedText);
      return JSON.parse(decompressedText) as Array<string>;
    }
    return null;
  }
}

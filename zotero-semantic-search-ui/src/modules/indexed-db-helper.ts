import Dexie from 'dexie';

export class IndexedDbHelper extends Dexie {
  private texts: Dexie.Table<{ id: string; texts: Array<string> }, string>;

  constructor() {
    super('TextDatabase');
    this.version(1).stores({
      texts: 'id',
    });

    this.texts = this.table('texts');
  }

  async addText(id: string, texts: Array<string>): Promise<void> {
    await this.texts.put({ id, texts });
  }

  async getText(id: string): Promise<Array<string> | null> {
    const result = await this.texts.get(id);
    return result?.texts ?? null;
  }
}

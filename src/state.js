import fs from "node:fs/promises";
import path from "node:path";

export class StateStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { version: 1, tables: {} };
  }

  async load() {
    try {
      this.data = JSON.parse(await fs.readFile(this.filePath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return this;
  }

  table(appToken, tableId) {
    const key = `${appToken}/${tableId}`;
    this.data.tables[key] ||= { records: {} };
    return this.data.tables[key];
  }

  async save() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, this.filePath);
  }
}

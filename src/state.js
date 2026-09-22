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

  async archiveAssignment(name, snapshot) {
    if (!/^[0-9]{4}-[0-9]{2}-r[0-9]+$/.test(name)) throw new Error("快照名称无效");
    const directory = path.join(path.dirname(this.filePath), "assignment-snapshots");
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, `${name}.json`);
    const contents = `${JSON.stringify(snapshot, null, 2)}\n`;
    try { await fs.writeFile(file, contents, { mode: 0o600, flag: "wx" }); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (await fs.readFile(file, "utf8") !== contents) throw new Error("月度快照已存在且内容不同，停止覆盖");
    }
    return file;
  }
}

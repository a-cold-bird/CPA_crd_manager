import fs from 'fs';
import path from 'path';

export function createSerializedJsonStore({ filePath, createDefault, normalize }) {
  let mutationTail = Promise.resolve();
  let temporaryFileCounter = 0;

  const read = () => {
    if (!fs.existsSync(filePath)) {
      return normalize(createDefault());
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    return normalize(JSON.parse(raw));
  };

  const writeAtomic = (state) => {
    const normalized = normalize(state);
    const directory = path.dirname(filePath);
    fs.mkdirSync(directory, { recursive: true });
    temporaryFileCounter += 1;
    const temporaryPath = `${filePath}.${process.pid}.${temporaryFileCounter}.tmp`;
    try {
      const descriptor = fs.openSync(temporaryPath, 'w');
      try {
        fs.writeFileSync(descriptor, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      fs.renameSync(temporaryPath, filePath);
    } catch (error) {
      try {
        fs.rmSync(temporaryPath, { force: true });
      } catch {
        // Preserve the original write error.
      }
      throw error;
    }
    return normalized;
  };

  const mutate = (mutator) => {
    const operation = mutationTail.then(() => {
      const state = read();
      const result = mutator(state);
      if (result && typeof result.then === 'function') {
        throw new Error('Serialized JSON mutations must be synchronous');
      }
      writeAtomic(state);
      return result;
    });
    mutationTail = operation.then(() => undefined, () => undefined);
    return operation;
  };

  return {
    read,
    mutate,
  };
}

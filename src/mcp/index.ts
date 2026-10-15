import { statSync } from 'node:fs';
import { Catalog } from '../catalog.js';
import { CatalogError, type CatalogRepository } from '../domain.js';
import { SqliteCatalogRepository } from '../adapters/sqlite.js';

/** Open and close a strictly read-only SQLite handle for each query.
 * A later explicit CLI scan becomes visible without restarting the MCP host.
 * Missing files stay missing: never mkdir, create, migrate, or scan here.
 */
export function openReadOnlyCatalog(filename: string): Catalog {
  const repository: CatalogRepository = {
    read() {
      try { statSync(filename); }
      catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
        throw error;
      }
      const connection = new SqliteCatalogRepository(filename, true);
      try { return connection.read(); }
      finally { connection.close(); }
    },
    replace() { throw new CatalogError('READ_ONLY', 'The MCP catalog is read-only. Use the catalog CLI scan separately.'); },
    close() {}
  };
  return new Catalog(repository);
}

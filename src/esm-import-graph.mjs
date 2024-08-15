//
// Naive ESM module dependency tree extraction
//
// Usage: node esm-import-graph.mjs input-path [--verbose]
// - input-path: Relative path to config.basePath for input file.
// --verbose: If specified, enables verbose log output.
//
// NOTE: ❗️ This still needs A LOT of work to actually be workable... See TODOs.
//

import fsp from 'node:fs/promises';
import path from 'node:path';
import url from 'node:url';
import JSON5 from 'json5';
import * as rtv from 'rtvjs';
import merge from 'lodash-es/merge.js';

const __dirname = path.dirname(path.resolve(url.fileURLToPath(import.meta.url)));
const userConfigPath = path.resolve('./esm-import-graph.conf.json');

/**
 * @typedef {Object} Config
 * @property {string} basePath Absolute path used to resolve non-relative imports like
 *  'foo/bar/baz.js'. Defaults the current working directory.
 * @property {Array<string>} extensions List of extensions to use when an import references
 *  a file without extension. Defaults to 'ts, tsx, js, jsx'. List must contain at least
 *  one extension. List is in order of precedence when looking for an implicitly-referenced
 *  index file in an import reference that points to a directory.
 * @property {Record<string,string>} [aliases] Map of alias name to path relative to `basePath`.
 *  '*' is copied verbatim from what it matches. e.g. `'@@my-alias/*': '*'`.
 */

// USER config file Typeset
const userConfigTs = {
  basePath: rtv.STRING,
  // NOTE: optional in user config, not resolved config
  extensions: [rtv.OPTIONAL, rtv.ARRAY, {
    $: rtv.STRING,
    min: 1,
  }],
  aliases: [rtv.OPTIONAL, rtv.HASH_MAP, {
    // keys can optionally end with '/*' and cannot otherwise contain either of those characters
    keyExp: '^[^/*]+(\\/\\*)?$',
    // values must be strings; they can contain '*' to indicate where the remainder of the alias
    //  should be substituted
    $values: rtv.STRING,
  }],
};

// TODO: these should go into the config...
/**
 * @type {Regex[]}
 * File patterns to include.
 */
const includes = [/\.ts$/, /\.tsx$/, /\.js$/, /\.jsx$/];

// TODO: these should go into the config...
/**
 * @type {Regex[]}
 * File patterns to exclude. `includes` take precedence.
 */
const excludes = [/\.test\.+$/, /node_modules\//];

/**
 * Dependency tree node.
 * @typedef {Object} Node
 * @property {Node|null} parent Parent Node that imports (or depends on) this Node. `null` indicates
 *  a root Node (i.e. graph entry).
 * @property {string} filePath Absolute path of the Node.
 * @property {boolean} crawled True if this Node has been seen by the Crawler (and so an empty
 *  `deps` means it's a leaf Node); false if it needs crawling.
 * @property {Node[]} deps List of Nodes on which this Node depends (i.e. modules it imports).
 *  Empty if none.
 * @property {Error} [readError] If an error occurred trying to read the Node's file.
 */

/**
 * Map of absolute file paths to Nodes in the Tree.
 * @type {Record<string,Node>}
 */
const pathToNode = {};

/**
 * FIFO queue of Nodes to crawl.
 * @type {Node[]}
 */
const crawlerQueue = [];

/**
 * @type {Config}
 */
let config;

const verbose = process.argv.includes('-v') || process.argv.includes('--verbose');

//
// LOGGER
//

/**
 * Logs an error to STDERR.
 * @param {string} context Log context (e.g. function name).
 * @param {string} message Log message.
 */
const logError = (context, message) => {
  if (!context || !message) {
    throw new Error('context and message are required');
  }
  console.error(`[${context}] 🚫 ERROR: ${message}`);
};

/**
 * Logs a warning to STDERR.
 * @param {string} context Log context (e.g. function name).
 * @param {string} message Log message.
 */
const logWarn = (context, message) => {
  if (!context || !message) {
    throw new Error('context and message are required');
  }
  console.error(`[${context}] 🔺 WARN: ${message}`);
};

/**
 * Logs to STDOUT.
 * @param {string} context Log context (e.g. function name).
 * @param {string} message Log message.
 */
const log = (context, message) => {
  if (!context || !message) {
    throw new Error('context and message are required');
  }
  console.log(`[${context}] ${message}`);
};

//
// FUNCTIONS
//

/**
 * Makes a new Config object.
 * @param {Config} userConfig User Config to merge.
 * @returns New Config object.
 */
const mkConfig = (userConfig) => {
  return merge({
    basePath: path.resolve('.'),
    aliases: {},
    extensions: ['ts', 'tsx', 'js', 'jsx'], // also: in order of precedence for index files
  }, userConfig);
};

/**
 * Makes a new Node object.
 * @param {Object} params
 * @param {Node} [params.parent] Parent Node. `null` indicates a root Node or graph entry.
 * @param {string} params.filePath Absolute path to the file.
 * @returns {Node}
 */
const mkNode = ({ parent = null, filePath }) => {
  return {
    parent,
    filePath,
    crawled: false,
    deps: [],
    toString() {
      return `{Node filePath="${
        this.filePath
      }", crawled=${
        this.crawled
      }, deps=${
        this.deps.length
      }, readError=${
        this.readError ? `"${readError.message}"` : 'None'
      }}`;
    }
  };
};

// TODO: ❗️ impl is fraught with assumptions, needs a lot of hardening, like if '*' is found in the
//  alias, then it must be found in the mapped path, but we haven't validated that up front
/**
 * Resolves an aliased import reference to an import path.
 * @param {string} aliasName Name of an alias in `config.aliases` minus the '/*' postfix, if any.
 * @param {string} importRef Import reference to resolve against the alias.
 */
const resolveAlias = (aliasName, importRef) => {
  if (!config.aliases) {
    throw new Error(
      `config.aliases must be defined when resolving aliases; aliasName="${
        aliasName
      }", importRef="${importRef}"`
    );
  }

  // e.g. 'ALIAS' or 'ALIAS/*'
  const aliasKey = Object.keys(config.aliases).find((k) => k.startsWith(aliasName));
  if (!aliasKey) {
    throw new Error(
      `Failed to find alias given aliasName="${aliasName}"; importRef="${importRef}"`
    );
  }
  // e.g. '*' or 'foo/bar/*' or 'foo/*/bar' or 'foo/bar'
  const aliasValue = config.aliases[aliasKey];

  // check to see if there's a match sub reference we need to carry from the alias reference to the
  //  resolved path
  let subRef = '';
  if (aliasKey.endsWith('/*')) {
    subRef = importRef.replace(`${aliasName}/`, '');
  }

  const resolvedPath = path.resolve(config.basePath, aliasValue.replace(/\*/g, subRef));
  verbose && log(
    'resolveAlias',
    `Resolved importRef="${importRef}" using aliasKey="${
      aliasKey
    }" and aliasValue="${aliasValue}" -> ${resolvedPath}`
  );

  return resolvedPath;
};

/**
 * Determines if a file is included in search.
 * @param {string} filePath
 * @returns {boolean} True if file is included in search; false if it's excluded.
 */
const isIncluded = (filePath) => {
  if (includes.some((re) => !!re.exec(filePath))) {
    return true;
  }

  return !excludes.some((re) => !!re.exec(filePath));
};

/**
 * Gets a list of files in a given directory.
 * @param {string} dirPath Directory path containing files.
 * @returns {Promise<string[]>} List of files; empty if none.
 */
const getFilenames = async (dirPath) => {
  const files = await fsp.readdir(dirPath, { withFileTypes: true });
  return files.filter((d) => d.isFile()).map((d) => d.name);
};

/**
 * Resolves a given import reference to a file on disk.
 * @param {Node} node Node from which import is to be resolved.
 * @param {string} importRef Import reference from a source file.
 * @returns {Promise<{ importRef: string, importPath: string }>}
 *  - `importRef` is original reference.
 *  - `importPath` is absolute path to the file.
 *  Promise is rejected with an error if the reference is either ignored or cannot be resolved.
 */
const resolveImport = async (node, importRef) => {
  // could be:
  // - npm dependency like 'react' or 'lodash/merge': ignore
  // - alias reference like 'ALIAS' or 'ALIAS/*': resolve from `config.basePath` and use '*' if given
  // - relative path like './foo/Bar': resolve from parent Node
  // - non-relative path like 'foo/Bar': resolve from `config.basePath`

  // from RTV verification, we know the aliases are in the right format so we don't have to be
  //  too precise with the Regex
  const aliasNames = Object.keys(config.aliases || {}).map(
    (k) => k.match(/^(.+?)(\/\*)?$/)?.[1] || k
  );

  /** @type {string} */
  let importPath;

  // relative imports are the easiest
  if (importRef.startsWith('./')) {
    importPath = path.resolve(path.dirname(node.filePath), importRef);
  }

  if (!importPath) {
    // check for aliases next since they could look like npm dependencies but aren't
    const aliasName = aliasNames.find((n) => importRef.startsWith(n));
    if (aliasName) {
      importPath = resolveAlias(aliasName, importRef);
    }
  }

  if (!importPath) {
    // either an npm dependency or a non-relative path and we can't really know which one it is
    //  without exploring some more so start with assuming it's NOT an npm dependency and see
    //  if it resolves to a file from the base path
    importPath = path.resolve(config.basePath, importRef);
  }

  verbose && log('resolveImport', `Trying to resolve "${importRef}" -> "${importPath}"`);

  // do an early check to see if it's included (we may know already)
  if (!isIncluded(importPath)) {
    throw new Error(`"${importPath}" is excluded from crawling by a filter`);
  }

  // at this point, we have a path, but it may be to a file __without__ an extension, so we have
  //  to figure out what the extension is, if any
  /** @type {Stats} */
  let stats;
  try {
    stats = await fsp.stat(importPath);
  } catch {
    // ignore
  }

  // NOTE: just because it's found but not a file doesn't mean there isn't still a file there
  //  with the same name as what is probably a directory -- and if it's a directory, the import
  //  is likely referring to an index file inside of it
  if (!stats || !stats.isFile()) {
    if (stats?.isDirectory()) {
      verbose && log(
        'resolveImport',
        `Import path "${importPath}" is a directory: Looking for its index file`
      );
      // WITHOUT extension; we'll try all configured ones
      importPath = path.join(importPath, 'index');
    } else if (stats) {
      throw new Error(
        `Cannot resolve import path "${importPath}": Not a file nor a directory`
      );
    }
    // else, file not found, which means we have to check if it's an extension-less file reference
    //  (but it could also be an NPM package reference like 'react')

    // last portion of the path, so should be file name without ext
    // TODO: Or it's an NPM module name, but we can't be sure without searching node_modules
    //  directories up the chain, and we're keeping things simple by ignoring those, so we assume
    //  it could be a file)
    const baseName = path.basename(importPath);

    const dirPath = path.dirname(importPath);
    const fileNames = await getFilenames(dirPath);

    const fileName = fileNames.find((name) => {
      const re = new RegExp(`^${baseName}\\.(${config.extensions.join('|')})$`);
      return !!re.exec(name);
    });

    if (fileName) {
      importPath = path.join(dirPath, fileName);
      verbose && log(
        'resolveImport',
        `Resolved importRef="${importRef}" -> importPath="${importPath}"`
      );
      if (!isIncluded(importPath)) {
        throw new Error(
          `"${importPath}" is excluded from crawling by a filter`
        );
      }
    } else {
      throw new Error(
        `Could not find file named "${baseName}" with extension in [${
          config.extensions.join(', ')
        }] contained in dir "${dirPath}": NPM package reference?`
      );
    }
  }
  // else, we know it's a file already, and it's included for crawling

  return {
    importRef,
    importPath,
  };
};

/**
 * Gets imports from a given Node's file.
 * @param {Node} node
 * @returns {Promise<Array<{ importRef: string, importPath: string }>>} Resolved import paths.
 *  Empty if none.
 *  - `importRef` is original reference.
 *  - `importPath` is absolute path to the file.
 */
const getImports = async (node) => {
  /** @type {string} */
  let src;
  try {
    src = await fsp.readFile(node.filePath, { encoding: 'utf-8' });
  } catch (err) {
    logWarn('getImports', `Failed to read ${node}, skipping; error="${err.message}"`);
    node.crawled = true;
    node.readError = err;
    return [];
  }

  /** @type {Promise<{ importRef: string, importPath: string }>[]} */
  const resolutionPromises = [];

  // TODO: ❗️ Need to account for `export * from 'foo'`, or `export * as foo from 'bar'`
  // TODO: ❗️ Also need to capture what is imported, and then use that to inform the
  //  the resolution of the Node later on, e.g. `import { foo } from 'some/index'`
  //  does not mean that ALL of what `some/index` re-exports is imported, and so ALL
  //  those paths should be followed as downstream dependencies; ONLY what exports
  //  `foo` in 'some/index' should be resolved, and either that symbol is defined
  //  in 'some/index' so there's no further to go, or `foo` was imported from some
  //  other import in `some/index`, and that is the ONLY path that needs to be followed...
  const staticImportsRE = /(?:import|export) (?:[^{}]+?|{.+?}) from (['"])(\S+)\1;?\s/gms;
  const staticMatches = src.matchAll(staticImportsRE);
  for (const match of staticMatches) {
    resolutionPromises.push(resolveImport(node, match[2]));
  }

  const dynamicImportsRE = /import\(\s*?(['"])(.+?)\1\s*?\)/gsm;
  const dynamicMatches = src.matchAll(dynamicImportsRE);
  for (const match of dynamicMatches) {
    resolutionPromises.push(resolveImport(node, match[2]));
  }

  const results = await Promise.allSettled(resolutionPromises);
  results.filter((r) => r.status === 'rejected').forEach((result) => {
    verbose && logWarn(
      'getImports',
      `Skipped import in ${node}: ${result.reason.message}`
    );
  });

  /** @type {Array<{ importRef: string, importPath: string }>} */
  const resolvedImports = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);

  log(
    'getImports',
    `Resolved ${resolvedImports.length}${
      results.find((r) => r.status === 'rejected')
        ? `, skipped ${results.filter((r) => r.status === 'rejected').length}`
        : ''
    } imports in ${node}`
  );

  return resolvedImports;
}

/**
 * Resolves imports to Nodes and queues new ones for the Crawler.
 * @param {Node} node Node whose imports are being queued.
 * @param {Array<{ importRef: string, importPath: string }>} resolvedImports Resolved imports found
 *  in Node to be queued if necessary.
 *  - `importRef` is original reference.
 *  - `importPath` is absolute path to the file.
 */
const queueNodes = (node, resolvedImports) => {
  resolvedImports.forEach(({ importRef, importPath }) => {
    verbose && log(
      'queueNodes',
      `Found import in ${node}: "${importRef}" -> "${importPath}"`
    );
    const importNode = pathToNode[importPath];
    if (importNode) {
      verbose && log('queueNodes', `Import "${importRef}" already seen: ${importNode}`);
      if (importNode === node) {
        // TODO: circular dependencies aren't just a Node importing itself; it could come about with
        //  a much wider import loop, but with `pathToNode`, we should avoid an infinite loop
        logWarn('getImports', `Circular dependency detected: ${node} imports itself`);
      } else {
        node.deps.push(importNode);
      }
    } else {
      verbose && log('queueNodes', `Queing "${importPath}" to the crawler`);
      const depNode = mkNode({ filePath: importPath, parent: node });
      node.deps.push(depNode);
      crawlerQueue.push(depNode);
    }
  });
};

/**
 * Crawls the Nodes in the `crawlerQueue` until there are none left.
 */
const crawl = async () => {
  // TODO: ❗️ the stack easily blows here, runs out of memory; need a better way to keep the
  //  loop going without continuously deepening the hole of promise -> ... -> promise
  //  on every loop -- like maybe an async generator could help keep the loop going
  //  without perpetually increasing the stack size?
  const crawler = async () => {
    verbose && log('crawl.crawler', `${crawlerQueue.length} nodes in crawler queue`);

    /** @type {Node} */
    const node = crawlerQueue.shift(); // FIFO
    if (node) {
      log('crawl.crawler', `Crawling ${node}`);
      if (node.crawled) {
        throw new Error(`${node} has been crawled but is still in queue`);
      }

      const resolvedImports = await getImports(node);
      queueNodes(node, resolvedImports);
      node.crawled = true;

      await crawler(); // recursive
    }
  };

  await crawler();
};

/**
 * Prints the generated graphs in JSON format.
 * @param {Node[]} graphEntries Entries into the import graphs.
 */
const printJsonGraphs = async (graphEntries) => {
  /** @type {Record<string,Node>} Map of Node.filePath to Node */
  const seenNodes = {};

  /**
   * @param {Node} rootNode Starting point.
   * @param {Node} [node] Downstream dependency being traversed; defaults to
   *  `rootNode` at the start.
   */
  const traverse = (rootNode, node = rootNode) => {
    if (seenNodes[node.filePath]) {
      // circular dependency found!
      verbose && logWarn(
        'printJsonGraphs.traverse',
        `Found circular dependency in root ${rootNode} from ${node}`
      );
      const ref = node.parent
        ? path.relative(path.dirname(node.parent.filePath), node.filePath)
        : 'self';
      return `⭕️ Circular dependency to ${ref}`;
    } else if (node.deps.length > 0) {
      const json = {};
      node.deps.forEach((dep) => {
        const ref = path.relative(path.dirname(node.filePath), dep.filePath);
        json[ref] = traverse(rootNode, dep); // recursive
      });
      return json;
    }

    return null; // leaf
  };

  const json = {};
  graphEntries.forEach((entryNode) => {
    const ref = path.relative(config.basePath, entryNode.filePath);
    json[ref] = traverse(entryNode);
  });

  // TODO: make this configurable in the `config`
  const outPath = path.resolve('./esm-import-graph-graphs.json');
  await fsp.writeFile(
    outPath,
    JSON.stringify(json, undefined, 2),
    { encoding: 'utf-8' }
  );

  log('printJsonGraphs', `JSON graphs written to ${outPath}`);
};

/**
 * Prints the generated graphs in various formats per the Configuration.
 * @param {Node[]} graphEntries Entries into the import graphs.
 */
const printGraphs = async (graphEntries) => {
  try {
    await printJsonGraphs(graphEntries);
  } catch (err) {
    logError('printGraphs', `Failed to print JSON graphs: "${err.message}"`);
  }

  // TODO: printMermaidGraph() would be another option which would generate
  //  a Mermaid flowchart that could be loaded into https://mermaid.live/
  // ```
  // flowchart TD
  //     A[Christmas] -->|Get money| B(Go shopping)
  //     B --> C{Let me think}
  //     C -->|One| D[Laptop]
  //     C -->|Two| E[iPhone]
  //     C -->|Three| F[fa:fa-car Car]
  // ```
};

//
// MAIN
//

await (async () => {
  const userConfigStats = await fsp.stat(userConfigPath);
  let userConfig;

  if (userConfigStats.isFile()) {
    const content = await fsp.readFile(userConfigPath, { encoding: 'utf-8' });
    try {
      userConfig = JSON5.parse(content); // supports extended JSON so comments, etc
      rtv.verify(userConfig, userConfigTs);
    } catch (err) {
      logError('main', `Failed to parse ${userConfigPath}: "${err.message}"`);
      process.exit(1);
    }
  }

  config = mkConfig(userConfig);

  // TODO: Maybe this becomes an array (multiple seed paths) and you combine the results?
  //  Use a glob library that generates paths?
  const inputPath = process.argv[2] ? path.resolve(config.basePath, process.argv[2]) : undefined;
  try {
    if (!inputPath) {
      throw new Error('inputPath param is required');
    }
    const stats = await fsp.stat(inputPath);
    if (!stats.isFile()) {
      throw new Error(`inputPath param "${inputPath}" must be a file`);
    }
  } catch (err) {
    logError('main', err.message);
    process.exit(1);
  }

  /**
  * List of Nodes that seeded the search(es). These are essentially Trees, but may be
  *  inter-connected as graphs if one of the Nodes ends-up importing a Node that another Node
  *  imports.
  * @type {Node[]}
  */
  const graphEntries = [];

  const inputNode = mkNode({ filePath: inputPath });
  pathToNode[inputNode.filePath] = inputNode;
  graphEntries.push(inputNode);
  crawlerQueue.push(inputNode);

  await crawl();

  const uncrawledNodes = Object.values(pathToNode).filter((n) => !n.crawled);
  if (uncrawledNodes.length > 0) {
    throw new Error(
      `Uh oh! ${uncrawledNodes.length} Nodes were not crawled: Check crawler!`
    );
  }

  await printGraphs(graphEntries);
})();

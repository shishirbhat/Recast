/**
 * The evaluation scenarios: versioned, each one a pair of ordinary requests on a small shop app.
 *
 * - `tasks[].request` is what a real agent is asked, word for word, in both workflows. Nothing asks an agent to break
 *   anything, skip checks, or coordinate with the other task; each request is written as if the other didn't exist.
 * - `tasks[].sim` is the simulated agent's scripted edit for the same request (deterministic, for regression runs). It
 *   is one plausible way to do the request, chosen before any real agent ran; real agents may do it differently.
 * - `oracle` is the ground truth: acceptance tests that neither the agents nor Relay see, run on the combined result.
 *   They encode what both requests asked for, plus that existing behaviour still works.
 * - `designed` is what the scenario was written to probe. It is never used as ground truth; the oracle decides.
 *
 * Changing a scenario's files, requests, checks or oracle means bumping its version.
 */

export type Edit = [find: string, replace: string];
export interface TaskDef {
  id: string;
  request: string;
  scope: string[];
  /** The check the task's author would run: Relay runs it in the task's worktree; the baseline runs it in the clone. */
  check: string;
  sim: Record<string, Edit[]>;
}
export interface Scenario {
  id: string;
  version: number;
  title: string;
  designed: "works" | "breaks" | "text-conflict" | "uncertain";
  probes: string;
  /** Files added to or replacing the base app. */
  overlay?: Record<string, string>;
  contracts?: { id: string; definition: string }[];
  tasks: [TaskDef, TaskDef];
  oracle: Record<string, string>;
}

const T = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n";

/** The base app every scenario starts from (version 1). */
export const BASE_VERSION = 1;
export const BASE: Record<string, string> = {
  "package.json": JSON.stringify({ name: "shop", private: true, type: "module", scripts: { test: "node --test" } }, null, 2) + "\n",
  "README.md": "# Shop\n\nA small shop backend. `npm test` runs the tests.\n",
  "src/users.js": "export function getUser(id) {\n  return { id, name: 'Ada Lovelace', email: 'ada@example.com' };\n}\n",
  "src/users.test.js": `${T}import { getUser } from './users.js';\n\ntest('getUser returns the user', () => {\n  assert.equal(getUser(1).id, 1);\n  assert.equal(getUser(1).name, 'Ada Lovelace');\n});\n`,
  "src/greeting.js": "import { getUser } from './users.js';\n\nexport function greet(id) {\n  return `Hello, ${getUser(id).name}!`;\n}\n",
  "src/greeting.test.js": `${T}import { greet } from './greeting.js';\n\ntest('greets the user by name', () => assert.equal(greet(1), 'Hello, Ada Lovelace!'));\n`,
  "src/price.js": "export function formatPrice(cents) {\n  return '$' + (cents / 100).toFixed(2);\n}\n",
  "src/price.test.js": `${T}import { formatPrice } from './price.js';\n\ntest('formats cents as dollars', () => assert.equal(formatPrice(1999), '$19.99'));\n`,
  "src/cart.js": "import { formatPrice } from './price.js';\n\nexport function cartTotal(items) {\n  const cents = items.reduce((sum, i) => sum + i.cents * i.qty, 0);\n  return formatPrice(cents);\n}\n",
  "src/cart.test.js": `${T}import { cartTotal } from './cart.js';\n\ntest('totals the cart', () => assert.equal(cartTotal([{ cents: 250, qty: 2 }]), '$5.00'));\ntest('totals a large cart', () => assert.equal(cartTotal([{ cents: 5000, qty: 3 }]), '$150.00'));\n`,
  "src/config.js": "export const config = { port: 3000, timeoutMs: 5000, currency: 'USD' };\n",
  "src/settings.js": "import { config } from './config.js';\n\nexport function setting(key) {\n  return config[key];\n}\n",
  "src/settings.test.js": `${T}import { setting } from './settings.js';\n\ntest('reads a setting', () => assert.equal(setting('port'), 3000));\n`,
  "src/db.js": "import { DatabaseSync } from 'node:sqlite';\n\nexport const SCHEMA = 'CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL)';\n\nexport function openDb() {\n  const db = new DatabaseSync(':memory:');\n  db.exec(SCHEMA);\n  return db;\n}\n\nexport function addCustomer(db, name, email) {\n  db.prepare('INSERT INTO customers (name, email) VALUES (?, ?)').run(name, email);\n}\n",
  "src/report.js": "export function customerEmails(db) {\n  return db.prepare('SELECT email FROM customers ORDER BY id').all().map((r) => r.email);\n}\n",
  "src/db.test.js": `${T}import { openDb, addCustomer } from './db.js';\nimport { customerEmails } from './report.js';\n\ntest('stores customers and lists their emails', () => {\n  const db = openDb();\n  addCustomer(db, 'Ada', 'ada@example.com');\n  assert.deepEqual(customerEmails(db), ['ada@example.com']);\n});\n`,
  "vendor/textfmt/package.json": JSON.stringify({ name: "textfmt", version: "1.0.0", type: "module", main: "index.js" }, null, 2) + "\n",
  "vendor/textfmt/index.js": "export function titleCase(s) {\n  return s.replace(/\\b\\w/g, (c) => c.toUpperCase());\n}\n",
  "src/labels.js": "import { titleCase } from '../vendor/textfmt/index.js';\n\nexport function label(s) {\n  return titleCase(s);\n}\n",
  "src/labels.test.js": `${T}import { label } from './labels.js';\n\ntest('labels are title case', () => assert.equal(label('fresh tea'), 'Fresh Tea'));\n`,
};

const oracle = (body: string) => `${T}${body}`;

export const SCENARIOS: Scenario[] = [
  {
    id: "s01-independent",
    version: 1,
    title: "Two independent, valid changes",
    designed: "works",
    probes: "Relay should let unrelated work through (no false alarm).",
    tasks: [
      { id: "T-a", request: "Add a function `discount(cents, percent)` to src/price.js that returns the price in cents after taking off `percent` percent, rounded to the nearest cent. Add tests for it in src/discount.test.js.", scope: ["src/price.js", "src/discount.test.js"], check: "node --test src/discount.test.js src/price.test.js", sim: { "src/price.js": [["export function formatPrice", "export function discount(cents, percent) {\n  return Math.round(cents * (1 - percent / 100));\n}\n\nexport function formatPrice"]], "src/discount.test.js": [["", `${T}import { discount } from './price.js';\n\ntest('discount', () => assert.equal(discount(1000, 15), 850));\n`]] } },
      { id: "T-b", request: "Change the greeting in src/greeting.js to 'Welcome back, <name>!' (for example 'Welcome back, Ada Lovelace!') and update src/greeting.test.js.", scope: ["src/greeting.js", "src/greeting.test.js"], check: "node --test src/greeting.test.js", sim: { "src/greeting.js": [["`Hello, ${getUser(id).name}!`", "`Welcome back, ${getUser(id).name}!`"]], "src/greeting.test.js": [["'Hello, Ada Lovelace!'", "'Welcome back, Ada Lovelace!'"]] } },
    ],
    oracle: { "oracle/s01.check.js": oracle("import { discount, formatPrice } from '../src/price.js';\nimport { greet } from '../src/greeting.js';\n\ntest('discount', () => { assert.equal(discount(1000, 15), 850); assert.equal(discount(999, 50), 500); });\ntest('greeting', () => assert.equal(greet(1), 'Welcome back, Ada Lovelace!'));\ntest('prices unchanged', () => assert.equal(formatPrice(1999), '$19.99'));\n") },
  },
  {
    id: "s02-api-contract",
    version: 1,
    title: "A shared API contract changes shape while another task builds on the old shape",
    designed: "breaks",
    probes: "A change to a contract's response shape and a new consumer written against the old one.",
    contracts: [{ id: "users-api", definition: "getUser(id) returns the user record" }],
    tasks: [
      { id: "T-a", request: "Change getUser in src/users.js to return { id, profile: { name, email } } instead of putting name and email at the top level. Update src/users.test.js to match.", scope: ["src/users.js", "src/users.test.js"], check: "node --test src/users.test.js", sim: { "src/users.js": [["{ id, name: 'Ada Lovelace', email: 'ada@example.com' }", "{ id, profile: { name: 'Ada Lovelace', email: 'ada@example.com' } }"]], "src/users.test.js": [["getUser(1).name", "getUser(1).profile.name"]] } },
      { id: "T-b", request: "Add src/badge.js exporting `badge(id)`, which returns the user's name in upper case (for example 'ADA LOVELACE'), using getUser from src/users.js. Add a test in src/badge.test.js.", scope: ["src/badge.js", "src/badge.test.js"], check: "node --test src/badge.test.js", sim: { "src/badge.js": [["", "import { getUser } from './users.js';\n\nexport function badge(id) {\n  return getUser(id).name.toUpperCase();\n}\n"]], "src/badge.test.js": [["", `${T}import { badge } from './badge.js';\n\ntest('badge', () => assert.equal(badge(1), 'ADA LOVELACE'));\n`]] } },
    ],
    oracle: { "oracle/s02.check.js": oracle("import { getUser } from '../src/users.js';\nimport { badge } from '../src/badge.js';\nimport { greet } from '../src/greeting.js';\n\ntest('new shape', () => assert.equal(getUser(1).profile.name, 'Ada Lovelace'));\ntest('badge', () => assert.equal(badge(1), 'ADA LOVELACE'));\ntest('greeting still works', () => assert.equal(greet(1), 'Hello, Ada Lovelace!'));\n") },
  },
  {
    id: "s03-renamed-field",
    version: 1,
    title: "A renamed field consumed by another task's new code",
    designed: "breaks",
    probes: "Renaming a returned field while another task adds a consumer of the old name.",
    tasks: [
      { id: "T-a", request: "Rename the `email` field returned by getUser in src/users.js to `emailAddress`. Update src/users.test.js if needed.", scope: ["src/users.js", "src/users.test.js"], check: "node --test src/users.test.js", sim: { "src/users.js": [["email: 'ada@example.com'", "emailAddress: 'ada@example.com'"]] } },
      { id: "T-b", request: "Add src/notify.js exporting `notifyTarget(id)`, which returns 'mailto:' followed by the user's email address (for example 'mailto:ada@example.com'), using getUser from src/users.js. Add a test in src/notify.test.js.", scope: ["src/notify.js", "src/notify.test.js"], check: "node --test src/notify.test.js", sim: { "src/notify.js": [["", "import { getUser } from './users.js';\n\nexport function notifyTarget(id) {\n  return 'mailto:' + getUser(id).email;\n}\n"]], "src/notify.test.js": [["", `${T}import { notifyTarget } from './notify.js';\n\ntest('notify target', () => assert.equal(notifyTarget(1), 'mailto:ada@example.com'));\n`]] } },
    ],
    oracle: { "oracle/s03.check.js": oracle("import { getUser } from '../src/users.js';\nimport { notifyTarget } from '../src/notify.js';\n\ntest('renamed', () => assert.equal(getUser(1).emailAddress, 'ada@example.com'));\ntest('notify', () => assert.equal(notifyTarget(1), 'mailto:ada@example.com'));\n") },
  },
  {
    id: "s04-signature",
    version: 1,
    title: "A changed function signature used by another task's new code",
    designed: "breaks",
    probes: "A required parameter added to a function while another task adds a caller of the old signature.",
    tasks: [
      { id: "T-a", request: "Change formatPrice in src/price.js to formatPrice(cents, currency), where currency is required: 'USD' formats as '$19.99', 'EUR' as '€19.99', and a missing or unknown currency throws an Error. Update src/price.test.js and the existing caller in src/cart.js (use 'USD').", scope: ["src/price.js", "src/price.test.js", "src/cart.js"], check: "node --test src/price.test.js src/cart.test.js", sim: { "src/price.js": [["export function formatPrice(cents) {\n  return '$' + (cents / 100).toFixed(2);\n}", "const SYMBOLS = { USD: '$', EUR: '€' };\n\nexport function formatPrice(cents, currency) {\n  if (!SYMBOLS[currency]) throw new Error(`unknown currency: ${currency}`);\n  return SYMBOLS[currency] + (cents / 100).toFixed(2);\n}"]], "src/price.test.js": [["formatPrice(1999)", "formatPrice(1999, 'USD')"]], "src/cart.js": [["formatPrice(cents)", "formatPrice(cents, 'USD')"]] } },
      { id: "T-b", request: "Add src/receipt.js exporting `receiptLine(name, cents)`, which returns '<name>: <price>' (for example receiptLine('Tea', 250) is 'Tea: $2.50'), using formatPrice from src/price.js. Add a test in src/receipt.test.js.", scope: ["src/receipt.js", "src/receipt.test.js"], check: "node --test src/receipt.test.js", sim: { "src/receipt.js": [["", "import { formatPrice } from './price.js';\n\nexport function receiptLine(name, cents) {\n  return `${name}: ${formatPrice(cents)}`;\n}\n"]], "src/receipt.test.js": [["", `${T}import { receiptLine } from './receipt.js';\n\ntest('receipt line', () => assert.equal(receiptLine('Tea', 250), 'Tea: $2.50'));\n`]] } },
    ],
    oracle: { "oracle/s04.check.js": oracle("import { formatPrice } from '../src/price.js';\nimport { receiptLine } from '../src/receipt.js';\nimport { cartTotal } from '../src/cart.js';\n\ntest('currencies', () => { assert.equal(formatPrice(1999, 'EUR'), '€19.99'); assert.throws(() => formatPrice(1999)); });\ntest('receipt', () => assert.equal(receiptLine('Tea', 250), 'Tea: $2.50'));\ntest('cart', () => assert.equal(cartTotal([{ cents: 250, qty: 2 }]), '$5.00'));\n") },
  },
  {
    id: "s05-schema",
    version: 1,
    title: "A database schema change that breaks an application consumer",
    designed: "breaks",
    probes: "Renaming a table column in the schema while a query elsewhere (and a new one) uses the old column.",
    tasks: [
      { id: "T-a", request: "Rename the customers.email column to contact_email in src/db.js (the SCHEMA and addCustomer). Keep addCustomer's parameters as they are.", scope: ["src/db.js"], check: "node -e \"import('./src/db.js').then(m => { const db = m.openDb(); m.addCustomer(db, 'A', 'a@x.io'); })\"", sim: { "src/db.js": [["email TEXT NOT NULL", "contact_email TEXT NOT NULL"], ["(name, email)", "(name, contact_email)"]] } },
      { id: "T-b", request: "Add `customersByDomain(db, domain)` to src/report.js, returning the names of customers whose email ends with '@' + domain, ordered by id. Add a test in src/domain.test.js.", scope: ["src/report.js", "src/domain.test.js"], check: "node --test src/domain.test.js", sim: { "src/report.js": [["export function customerEmails", "export function customersByDomain(db, domain) {\n  return db.prepare('SELECT name FROM customers WHERE email LIKE ? ORDER BY id').all('%@' + domain).map((r) => r.name);\n}\n\nexport function customerEmails"]], "src/domain.test.js": [["", `${T}import { openDb, addCustomer } from './db.js';\nimport { customersByDomain } from './report.js';\n\ntest('by domain', () => {\n  const db = openDb();\n  addCustomer(db, 'Ada', 'ada@example.com');\n  addCustomer(db, 'Bo', 'bo@other.org');\n  assert.deepEqual(customersByDomain(db, 'example.com'), ['Ada']);\n});\n`]] } },
    ],
    oracle: { "oracle/s05.check.js": oracle("import { openDb, addCustomer, SCHEMA } from '../src/db.js';\nimport { customerEmails, customersByDomain } from '../src/report.js';\n\ntest('column renamed', () => assert.match(SCHEMA, /contact_email/));\ntest('reports work', () => {\n  const db = openDb();\n  addCustomer(db, 'Ada', 'ada@example.com');\n  addCustomer(db, 'Bo', 'bo@other.org');\n  assert.deepEqual(customerEmails(db), ['ada@example.com', 'bo@other.org']);\n  assert.deepEqual(customersByDomain(db, 'example.com'), ['Ada']);\n});\n") },
  },
  {
    id: "s06-dependency",
    version: 1,
    title: "A dependency upgrade incompatible with another task's new code",
    designed: "breaks",
    probes: "A vendored library's major version renames its API while another task starts using the old API. (Vendored, because trials run without network access to a package registry.)",
    tasks: [
      { id: "T-a", request: "Upgrade the vendored library in vendor/textfmt to version 2.0.0. In 2.0.0, titleCase is renamed to toTitleCase (same behaviour) and titleCase no longer exists. Update vendor/textfmt/index.js and its package.json version, and update src/labels.js, which uses it.", scope: ["vendor/textfmt/index.js", "vendor/textfmt/package.json", "src/labels.js"], check: "node --test src/labels.test.js", sim: { "vendor/textfmt/index.js": [["export function titleCase", "export function toTitleCase"]], "vendor/textfmt/package.json": [['"1.0.0"', '"2.0.0"']], "src/labels.js": [["import { titleCase }", "import { toTitleCase }"], ["return titleCase(s)", "return toTitleCase(s)"]] } },
      { id: "T-b", request: "Add src/heading.js exporting `heading(text)`, which returns the text in title case followed by ':' (for example heading('order summary') is 'Order Summary:'), using the vendored textfmt library in vendor/textfmt. Add a test in src/heading.test.js.", scope: ["src/heading.js", "src/heading.test.js"], check: "node --test src/heading.test.js", sim: { "src/heading.js": [["", "import { titleCase } from '../vendor/textfmt/index.js';\n\nexport function heading(text) {\n  return titleCase(text) + ':';\n}\n"]], "src/heading.test.js": [["", `${T}import { heading } from './heading.js';\n\ntest('heading', () => assert.equal(heading('order summary'), 'Order Summary:'));\n`]] } },
    ],
    oracle: { "oracle/s06.check.js": oracle("import { readFileSync } from 'node:fs';\nimport { label } from '../src/labels.js';\nimport { heading } from '../src/heading.js';\n\ntest('upgraded', () => assert.equal(JSON.parse(readFileSync(new URL('../vendor/textfmt/package.json', import.meta.url), 'utf8')).version, '2.0.0'));\ntest('labels', () => assert.equal(label('fresh tea'), 'Fresh Tea'));\ntest('heading', () => assert.equal(heading('order summary'), 'Order Summary:'));\n") },
  },
  {
    id: "s07-shared-file",
    version: 1,
    title: "Two changes to the same line of a shared file",
    designed: "text-conflict",
    probes: "Both tasks edit the one-line config object; a correct merge exists but needs a person (or a rerun).",
    tasks: [
      { id: "T-a", request: "Add a `retries: 3` setting to the config object in src/config.js.", scope: ["src/config.js"], check: "node -e \"import('./src/config.js').then(m => { if (m.config.retries !== 3) process.exit(1) })\"", sim: { "src/config.js": [["currency: 'USD' }", "currency: 'USD', retries: 3 }"]] } },
      { id: "T-b", request: "Change the default port in src/config.js from 3000 to 8080, and add a `logLevel: 'info'` setting to the same config object.", scope: ["src/config.js", "src/settings.test.js"], check: "node -e \"import('./src/config.js').then(m => { if (m.config.port !== 8080 || m.config.logLevel !== 'info') process.exit(1) })\"", sim: { "src/config.js": [["port: 3000", "port: 8080"], ["currency: 'USD' }", "currency: 'USD', logLevel: 'info' }"]], "src/settings.test.js": [["setting('port'), 3000", "setting('port'), 8080"]] } },
    ],
    oracle: { "oracle/s07.check.js": oracle("import { config } from '../src/config.js';\n\ntest('both settings', () => { assert.equal(config.retries, 3); assert.equal(config.port, 8080); assert.equal(config.logLevel, 'info'); });\n") },
  },
  {
    id: "s08-failing-test",
    version: 1,
    title: "A change that makes an existing test elsewhere fail",
    designed: "breaks",
    probes: "One task's own check passes but an existing project test it didn't run fails; the other task is unrelated.",
    tasks: [
      { id: "T-a", request: "Make cartTotal in src/cart.js take 10% off when the total is over $100 (so 15000 cents becomes '$135.00'). Add a test for the discount in src/cart-discount.test.js.", scope: ["src/cart.js", "src/cart-discount.test.js"], check: "node --test src/cart-discount.test.js", sim: { "src/cart.js": [["  return formatPrice(cents);", "  return formatPrice(cents > 10000 ? Math.round(cents * 0.9) : cents);"]], "src/cart-discount.test.js": [["", `${T}import { cartTotal } from './cart.js';\n\ntest('discount over $100', () => assert.equal(cartTotal([{ cents: 5000, qty: 3 }]), '$135.00'));\n`]] } },
      { id: "T-b", request: "Change the greeting in src/greeting.js to 'Hi, <name>!' and update src/greeting.test.js.", scope: ["src/greeting.js", "src/greeting.test.js"], check: "node --test src/greeting.test.js", sim: { "src/greeting.js": [["`Hello, ${getUser(id).name}!`", "`Hi, ${getUser(id).name}!`"]], "src/greeting.test.js": [["'Hello, Ada Lovelace!'", "'Hi, Ada Lovelace!'"]] } },
    ],
    // The project's own suite must pass after integration: a merged change that leaves a failing test behind is broken.
    oracle: { "oracle/s08.check.js": oracle("import { execFileSync } from 'node:child_process';\nimport { cartTotal } from '../src/cart.js';\nimport { greet } from '../src/greeting.js';\n\ntest('discount', () => assert.equal(cartTotal([{ cents: 5000, qty: 3 }]), '$135.00'));\ntest('greeting', () => assert.equal(greet(1), 'Hi, Ada Lovelace!'));\ntest('the project suite passes', () => { const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('NODE_TEST'))); execFileSync(process.execPath, ['--test'], { cwd: new URL('..', import.meta.url), env, stdio: 'pipe' }); });\n") },
  },
  {
    id: "s09-looks-conflicting",
    version: 1,
    title: "Changes that look related but are compatible",
    designed: "works",
    probes: "Both touch the user record and its consumers, but additively: Relay should not cry wolf.",
    tasks: [
      { id: "T-a", request: "Add a `fullName` field to the object getUser returns in src/users.js (same value as `name`), keeping `name` for existing callers. Update src/users.test.js.", scope: ["src/users.js", "src/users.test.js"], check: "node --test src/users.test.js", sim: { "src/users.js": [["name: 'Ada Lovelace',", "name: 'Ada Lovelace', fullName: 'Ada Lovelace',"]], "src/users.test.js": [["assert.equal(getUser(1).name, 'Ada Lovelace');", "assert.equal(getUser(1).name, 'Ada Lovelace');\n  assert.equal(getUser(1).fullName, 'Ada Lovelace');"]] } },
      { id: "T-b", request: "Change greet in src/greeting.js to use only the user's first name ('Hello, Ada!'), and update src/greeting.test.js.", scope: ["src/greeting.js", "src/greeting.test.js"], check: "node --test src/greeting.test.js", sim: { "src/greeting.js": [["`Hello, ${getUser(id).name}!`", "`Hello, ${getUser(id).name.split(' ')[0]}!`"]], "src/greeting.test.js": [["'Hello, Ada Lovelace!'", "'Hello, Ada!'"]] } },
    ],
    oracle: { "oracle/s09.check.js": oracle("import { getUser } from '../src/users.js';\nimport { greet } from '../src/greeting.js';\n\ntest('both', () => { assert.equal(getUser(1).fullName, 'Ada Lovelace'); assert.equal(getUser(1).name, 'Ada Lovelace'); assert.equal(greet(1), 'Hello, Ada!'); });\n") },
  },
  {
    id: "s10-uncertain",
    version: 1,
    title: "An interaction Relay can't see statically, and tests may not cover",
    designed: "uncertain",
    probes: "A setting renamed in a config object that another task's new code reads by a computed key; whether anything catches it depends on what the tests check.",
    tasks: [
      { id: "T-a", request: "Store the timeout in seconds instead of milliseconds: in src/config.js replace `timeoutMs: 5000` with `timeoutSeconds: 5`.", scope: ["src/config.js"], check: "node -e \"import('./src/config.js').then(m => { if (m.config.timeoutSeconds !== 5) process.exit(1) })\"", sim: { "src/config.js": [["timeoutMs: 5000", "timeoutSeconds: 5"]] } },
      { id: "T-b", request: "Add src/retry.js exporting `retryDelay(attempt)`, which returns attempt × (the configured timeout in milliseconds) ÷ 10, reading the timeout with setting('timeoutMs') from src/settings.js. For example retryDelay(2) is 1000. Add a test in src/retry.test.js.", scope: ["src/retry.js", "src/retry.test.js"], check: "node --test src/retry.test.js", sim: { "src/retry.js": [["", "import { setting } from './settings.js';\n\nexport function retryDelay(attempt) {\n  return (attempt * setting('timeoutMs')) / 10;\n}\n"]], "src/retry.test.js": [["", `${T}import { retryDelay } from './retry.js';\n\ntest('retry delay is a number', () => assert.equal(typeof retryDelay(2), 'number'));\n`]] } },
    ],
    oracle: { "oracle/s10.check.js": oracle("import { config } from '../src/config.js';\nimport { retryDelay } from '../src/retry.js';\n\ntest('seconds', () => assert.equal(config.timeoutSeconds, 5));\ntest('retry delay', () => assert.equal(retryDelay(2), 1000));\n") },
  },
];

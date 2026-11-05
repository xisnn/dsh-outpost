/**
 * Packaging contract for the Host task bundle.
 *
 * This test does not need DSH installed: it checks the files a release must
 * ship and the declarations DSH's bundle loader depends on.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const BUNDLE = path.join(ROOT, 'dsh-outpost-butler');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  OK    ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${detail ? ` (${detail})` : ''}`);
  }
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

check('host bundle directory exists', fs.existsSync(BUNDLE));

const pkg = JSON.parse(read('dsh-outpost-butler/package.json'));
check('package name is @local/dsh-outpost-butler', pkg.name === '@local/dsh-outpost-butler', pkg.name);
check('package is marked private', pkg.private === true);
check('package is ESM', pkg.type === 'module');
check('main export is index.js', pkg.exports?.['.'] === './index.js');
check('dsh.bundle.patch is declared', pkg.dsh?.bundle?.patch === './cordis.patch.yml');
check('engines.dsh targets 0.2.x', String(pkg.engines?.dsh ?? '').includes('>=0.2.0 <0.3.0'), pkg.engines?.dsh);
check('files includes lib', Array.isArray(pkg.files) && pkg.files.includes('lib'));
check('files includes cordis.patch.yml', Array.isArray(pkg.files) && pkg.files.includes('cordis.patch.yml'));

const patch = read('dsh-outpost-butler/cordis.patch.yml');
check('bundle patch inserts outpost-butler', patch.includes('id: outpost-butler'));
check('bundle patch names the package', patch.includes("name: '@local/dsh-outpost-butler'"));

const entry = read('dsh-outpost-butler/index.js');
check('entry exports a name', entry.includes('export const name'));
check('entry injects goals', entry.includes("'goals'"));
check('entry injects sessionController', entry.includes("'sessionController'"));
check('entry injects storageDomain', entry.includes("'storageDomain'"));
check('entry injects connection', entry.includes("'connection'"));

const domain = read('dsh-outpost-butler/lib/domain.js');
check('storage domain is named outpost_butler', domain.includes("name: 'outpost_butler'"));

const setup = read('setup-butler.ps1');
check('setup-butler.ps1 exists and names the bundle', setup.includes('@local/dsh-outpost-butler'));
check('installer helper ships with setup', fs.existsSync(path.join(ROOT, 'scripts/butler-installer.ps1')));
const workflow = read('.github/workflows/android.yml');
check('workflow builds an installable Host archive', workflow.includes('npm pack ./dsh-outpost-butler --pack-destination out'));
check('release uploads the Host archive', /files:\s*\|[\s\S]*?out\/\*\.tgz/.test(workflow));
check('release checksums cover APK and Host archive', workflow.includes('sha256sum *.apk *.tgz > SHA256SUMS.txt'));

check('docs/butler-tasks.md exists', fs.existsSync(path.join(ROOT, 'docs', 'butler-tasks.md')));
check('mobile task screen exists', fs.existsSync(path.join(ROOT, 'dsh-mobile/src/screens/ButlerTasksScreen.tsx')));
check('mobile task client exists', fs.existsSync(path.join(ROOT, 'dsh-mobile/src/core/butlerTasks.ts')));

console.log(`\nbutler-packaging-spec: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

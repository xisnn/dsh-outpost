import { isNewer } from '../src/core/semver.ts';

const cases = [
  ['0.2.0', '0.1.0', true],
  ['0.1.0', '0.2.0', false],
  ['0.2.0', '0.2.0', false],
  ['0.10.0', '0.9.0', true],
  ['1.0.0', '0.99.9', true],
  ['0.2.1', '0.2.0', true],
  ['v0.3.0', '0.2.0', true],
  ['v1.0.0-beta.1', '0.9.0', true],
];

let pass = 0;
let fail = 0;
for (const [a, b, exp] of cases) {
  const got = isNewer(a, b);
  if (got === exp) {
    pass += 1;
    console.log(`  OK    ${a} > ${b} = ${got}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${a} > ${b} = ${got} (期望 ${exp})`);
  }
}
console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);

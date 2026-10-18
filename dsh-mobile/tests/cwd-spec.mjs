// 验证 normalizeCwd 的去重与尾部斜杠处理
function normalizeCwd(raw) {
  if (!raw) return '';
  return raw.replace(/\\{2,}/g, '\\').replace(/\/{2,}/g, '/').replace(/[\\/]+$/, '');
}

const cases = [
  ['E:\\\\work\\\\dsBot', 'E:\\work\\dsBot', '双反斜杠应归一到单'],
  ['E:\\work\\dsBot', 'E:\\work\\dsBot', '正常单反斜杠不变'],
  ['E:\\work\\dsBot\\', 'E:\\work\\dsBot', '去掉尾部斜杠'],
  ['E:/work/dsBot', 'E:/work/dsBot', '正斜杠保持'],
  ['', '', '空值'],
  ['C:\\Users\\\\xis\\Documents\\deepseek-harness\\default-workspace',
   'C:\\Users\\xis\\Documents\\deepseek-harness\\default-workspace', '深层路径'],
];

let pass = 0, fail = 0;
for (const [input, expected, label] of cases) {
  const got = normalizeCwd(input);
  if (got === expected) { pass++; console.log(`  OK    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n         in=${JSON.stringify(input)}\n         got=${JSON.stringify(got)}\n         exp=${JSON.stringify(expected)}`); }
}
console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);

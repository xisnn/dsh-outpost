/**
 * `xlsx/dist/xlsx.mini.min.js` 的类型声明。
 *
 * 为什么要单独用这个文件：xlsx 的包主入口会 require 一整张代码页表
 * （cpexcel.js），Metro 打不散那个动态 require，RN 上运行会报
 * `Requiring unknown module "867"`。mini 版不含它，体积也小得多。
 *
 * mini 版和主包是同一套 API 的子集，所以直接复用 xlsx 的类型。
 */
declare module 'xlsx/dist/xlsx.mini.min.js' {
  import type * as XLSX from 'xlsx';
  const lib: typeof XLSX;
  export default lib;
  export const read: typeof XLSX.read;
  export const utils: typeof XLSX.utils;
}
